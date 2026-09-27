import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingFundingSnapshot, HoldStatus } from '@balo/shared/credit';

const mockReadSnapshot = vi.fn();
const mockFindNameById = vi.fn();
const mockHasCapability = vi.fn();
const mockLogWarn = vi.fn();
const mockLogInfo = vi.fn();
const mockLogError = vi.fn();
const mockPublishNotificationEvent = vi.fn();
const mockTrackServerAndFlush = vi.fn();
const mockResolveBookingExpertDisplay = vi.fn();
const mockCaptureException = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock('@balo/db', () => ({
  bookingFundingRepository: {
    readSnapshot: (...args: unknown[]) => mockReadSnapshot(...args),
  },
  companiesRepository: {
    findNameById: (...args: unknown[]) => mockFindNameById(...args),
  },
}));
vi.mock('@/lib/authz', () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
  CAPABILITIES: { MANAGE_BILLING: 'manage_billing' },
}));
vi.mock('@/lib/logging', () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
    info: (...args: unknown[]) => mockLogInfo(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublishNotificationEvent(...args),
}));
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrackServerAndFlush(...args),
  BOOKING_SERVER_EVENTS: { FUNDING_BLOCKED: 'booking_funding_blocked' },
}));
vi.mock('./load-booking-context', () => ({
  resolveBookingExpertDisplay: (...args: unknown[]) => mockResolveBookingExpertDisplay(...args),
}));

import { enforceBookingFunding, type EnforceBookingFundingInput } from './booking-funding-gate';

const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';
const WALLET_ID = 'wallet-1';
const NOW_ISO = '2026-09-21T10:15:00.000Z';

const SLOT_30 = { startIso: '2026-09-22T10:00:00.000Z', endIso: '2026-09-22T10:30:00.000Z' };
const SLOT_60 = { startIso: '2026-09-22T10:00:00.000Z', endIso: '2026-09-22T11:00:00.000Z' };

const BASE_INPUT: EnforceBookingFundingInput = {
  actorUserId: USER_ID,
  companyId: COMPANY_ID,
  expertProfileId: EXPERT_PROFILE_ID,
  slot: SLOT_30,
  activeCompanyId: COMPANY_ID,
  onCoveredHold: 'defer',
};

/** A$375/hr client rate over 30 minutes = A$187.50. */
const ESTIMATE_30_MINOR = 18_750;

function noMandate(
  availableMinor: number,
  reservable: Extract<BookingFundingSnapshot, { kind: 'no_mandate' }>['reservable'] = [],
  expertRateCents: number | null = 30_000
): BookingFundingSnapshot {
  return { kind: 'no_mandate', walletId: WALLET_ID, expertRateCents, availableMinor, reservable };
}

function onHold(amountToClearMinor: number): BookingFundingSnapshot {
  const hold: HoldStatus = {
    onHold: true,
    openReceivableCount: 1,
    confirmationWasRequested: false,
    balanceMinor: -5_000,
    promoGrantedSinceDebtMinor: 0,
    amountToClearMinor,
  };
  return { kind: 'on_hold', walletId: WALLET_ID, hold };
}

const PLANNED_30_MIN = {
  meetingId: 'meeting-planned',
  scheduledStart: new Date('2026-09-23T10:00:00.000Z'),
  scheduledEnd: new Date('2026-09-23T10:30:00.000Z'),
  expertProfileId: EXPERT_PROFILE_ID,
  expertRateCents: 30_000,
};

function lastAnalytics(): Record<string, unknown> {
  const [, properties] = mockTrackServerAndFlush.mock.calls[0] as [string, Record<string, unknown>];
  return properties;
}

function lastPayload(): Record<string, unknown> {
  const [, payload] = mockPublishNotificationEvent.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  return payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHasCapability.mockResolvedValue(false);
  mockFindNameById.mockResolvedValue({ name: 'Northwind Industrial' });
  mockResolveBookingExpertDisplay.mockResolvedValue({
    firstName: 'Dana',
    lastName: 'Okoro',
    partyLabel: 'CloudPeak',
  });
});

afterEach(() => {
  // Restored here, not in the test body, so a failure mid-test can't leak fake timers into the
  // next test.
  vi.useRealTimers();
});

describe('enforceBookingFunding — the unfunded arm (BAL-478)', () => {
  it('mandate snapshot: passes on ONE repository read and nothing else is consulted', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'mandate', walletId: WALLET_ID });

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: true });
    expect(mockReadSnapshot).toHaveBeenCalledTimes(1);
    expect(mockFindNameById).not.toHaveBeenCalled();
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('reads the snapshot for THIS company and expert, at the instant it later dates the figure with', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    mockReadSnapshot.mockResolvedValue({ kind: 'mandate', walletId: WALLET_ID });

    await enforceBookingFunding(BASE_INPUT);

    expect(mockReadSnapshot).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      now: new Date(NOW_ISO),
    });
  });

  it('balance arm alone: exactly-equal available passes (the >= boundary)', async () => {
    mockReadSnapshot.mockResolvedValue(noMandate(ESTIMATE_30_MINOR));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: true });
  });

  it('one minor short of the estimate refuses, reason no_mandate_insufficient_balance', async () => {
    mockReadSnapshot.mockResolvedValue(noMandate(ESTIMATE_30_MINOR - 1));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'booking_funding_blocked',
      expect.objectContaining({ reason: 'no_mandate_insufficient_balance' })
    );
  });

  it('the estimate is derived from the SLOT WINDOW — the same credit that covers 30 minutes refuses 60', async () => {
    mockReadSnapshot.mockResolvedValue(noMandate(ESTIMATE_30_MINOR));

    const result = await enforceBookingFunding({ ...BASE_INPUT, slot: SLOT_60 });

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(lastAnalytics()).toMatchObject({ duration_minutes: 60 });
  });

  /**
   * `estimateMinor`/`availableMinor` are the ONLY place the unfunded shortfall exists (panel,
   * email, in-app and PostHog all deliberately carry no figure on that arm).
   */
  it('REV-2 — the refusal log line carries the exact estimate and available figures', async () => {
    mockReadSnapshot.mockResolvedValue(noMandate(ESTIMATE_30_MINOR - 1));

    await enforceBookingFunding(BASE_INPUT);

    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking refused before any write — funding pre-condition unmet',
      expect.objectContaining({
        estimateMinor: ESTIMATE_30_MINOR,
        availableMinor: ESTIMATE_30_MINOR - 1,
      })
    );
  });

  it('R5 — no wallet: refuses with no_wallet, does not throw', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'no_wallet' });

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'booking_funding_blocked',
      expect.objectContaining({ reason: 'no_wallet' })
    );
  });

  it('§4.3 — a rate-less expert passes (unevaluable, not a refusal) and logs a warning', async () => {
    mockReadSnapshot.mockResolvedValue(noMandate(0, [], null));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: true });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking funding pre-check skipped — expert has no rate',
      expect.objectContaining({ expertProfileId: EXPERT_PROFILE_ID })
    );
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  /**
   * SEC-3 — an UNKNOWN, client-supplied `expertProfileId` is NOT the §4.3 rate-less case: it has
   * no owner and no reason to pass. Fails closed as `'unavailable'`, distinct from the positive
   * control immediately above (a KNOWN, rate-less expert, which still passes).
   */
  it('SEC-3 — an unknown expert profile fails CLOSED as unavailable, distinct from a rate-less one', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'unknown_expert', walletId: WALLET_ID });

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('a read throwing fails CLOSED — unavailable, logged, and publishes NOTHING', async () => {
    mockReadSnapshot.mockRejectedValue(new Error('connection reset'));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Booking funding pre-check read failed — failing CLOSED',
      expect.objectContaining({ userId: USER_ID, companyId: COMPANY_ID })
    );
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  /**
   * SEC-1 / REV-3 — a blip in `hasCapability` AFTER the refusal is already determined must NOT
   * re-classify it as `'unavailable'` (which would also silently skip the fan-out). A failed
   * capability read is treated as a NON-holder.
   */
  it('SEC-1 — a hasCapability rejection is treated as non-holder, NOT re-classified as unavailable', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'no_wallet' });
    mockHasCapability.mockRejectedValue(new Error('membership read timed out'));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockLogError).toHaveBeenCalledWith(
      'Booking funding capability read failed — treating the actor as a non-holder',
      expect.objectContaining({ userId: USER_ID, companyId: COMPANY_ID })
    );
    // The fan-out still fires — a capability-read blip must not suppress the promised notice.
    expect(mockPublishNotificationEvent).toHaveBeenCalledTimes(1);
  });

  /**
   * REV-3 — a publish failure must not turn the refusal into `'unavailable'` either. Logged
   * (Axiom + Sentry) and swallowed; the refusal is still returned. `publishNotificationEvent` is
   * called synchronously without `await`, so only a SYNCHRONOUS throw from it is caught here —
   * hence `mockImplementationOnce`, not `mockRejectedValue`.
   */
  it('REV-3 — a publish failure is logged to Sentry and swallowed; the refusal is still returned', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'no_wallet' });
    mockPublishNotificationEvent.mockImplementationOnce(() => {
      throw new Error('queue unavailable');
    });

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockLogError).toHaveBeenCalledWith(
      'Booking funding blocked fan-out failed to publish',
      expect.objectContaining({ companyId: COMPANY_ID })
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('the fan-out promise: publishes booking.funding_blocked with a kind-and-hour-bucketed correlationId and NO figure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    mockReadSnapshot.mockResolvedValue({ kind: 'no_wallet' });

    const result = await enforceBookingFunding(BASE_INPUT);

    const expectedBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockPublishNotificationEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith('booking.funding_blocked', {
      correlationId: `booking-funding:${COMPANY_ID}:${USER_ID}:unfunded:${expectedBucket}`,
      companyId: COMPANY_ID,
      // A bare user id, never a pre-rendered name (the resolver hydrates the name and decides
      // whether the booker should be dropped from the fan-out).
      requestedByUserId: USER_ID,
      expertPartyLabel: 'CloudPeak',
      blockKind: 'unfunded',
    });
    // The unfunded arm carries no money figure and no as-of.
    expect(Object.keys(lastPayload())).not.toContain('topUpNeededMinor');
    expect(Object.keys(lastPayload())).not.toContain('asOfIso');
  });

  it('self-serve branch: canManageBilling true, publish STILL happens (unconditional)', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'no_wallet' });
    mockHasCapability.mockResolvedValue(true);

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: true });
    expect(mockPublishNotificationEvent).toHaveBeenCalledTimes(1);
  });

  /**
   * REV-4 — pin `hasCapability`'s ARGUMENTS. The panel's CTA branch hangs entirely on this call:
   * a wrong scope discriminant (`{ agencyId }`) or a wrong capability token would still pass
   * every other assertion in this file.
   */
  it('REV-4 — hasCapability is called with the exact actor, capability token and COMPANY scope', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'no_wallet' });

    await enforceBookingFunding(BASE_INPUT);

    expect(mockHasCapability).toHaveBeenCalledWith({ id: USER_ID }, 'manage_billing', {
      companyId: COMPANY_ID,
    });
  });

  it('analytics: fires exactly once on the unfunded arm with the exact key set and no money property', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'no_wallet' });

    await enforceBookingFunding(BASE_INPUT);

    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    expect(Object.keys(lastAnalytics()).sort((a, b) => a.localeCompare(b))).toEqual([
      'can_manage_billing',
      'distinct_id',
      'duration_minutes',
      'expert_id',
      'reason',
    ]);
  });

  it('positive control: the funded path fires NO analytics and NO publish (mutation proof for the two "not called" assertions above)', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'mandate', walletId: WALLET_ID });

    await enforceBookingFunding(BASE_INPUT);

    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });
});

describe('enforceBookingFunding — an open receivable refuses the booking (D6.1)', () => {
  it('refuses with the top-up figure, the billing company and canManageBilling', async () => {
    mockReadSnapshot.mockResolvedValue(onHold(27_500));
    mockHasCapability.mockResolvedValue(true);

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({
      ok: false,
      reason: 'on_hold',
      canManageBilling: true,
      billingCompany: { id: COMPANY_ID, name: 'Northwind Industrial', isActive: true },
      topUpNeededMinor: 27_500,
    });
  });

  it('billingCompany.isActive is false when the held company is not the active workspace', async () => {
    mockReadSnapshot.mockResolvedValue(onHold(27_500));

    const result = await enforceBookingFunding({
      ...BASE_INPUT,
      activeCompanyId: OTHER_COMPANY_ID,
    });

    expect(result).toMatchObject({
      reason: 'on_hold',
      billingCompany: { id: COMPANY_ID, isActive: false },
    });
  });

  it('billingCompany.isActive is false when there is no active company at all', async () => {
    mockReadSnapshot.mockResolvedValue(onHold(27_500));

    const result = await enforceBookingFunding({ ...BASE_INPUT, activeCompanyId: null });

    expect(result).toMatchObject({ reason: 'on_hold', billingCompany: { isActive: false } });
  });

  it('a failed company-name read degrades to a null name and still refuses (never `unavailable`)', async () => {
    mockReadSnapshot.mockResolvedValue(onHold(27_500));
    mockFindNameById.mockRejectedValue(new Error('read timed out'));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toMatchObject({
      ok: false,
      reason: 'on_hold',
      billingCompany: { id: COMPANY_ID, name: null, isActive: true },
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking funding company name read failed — the panel falls back to a neutral label',
      expect.objectContaining({ companyId: COMPANY_ID })
    );
    expect(mockPublishNotificationEvent).toHaveBeenCalledTimes(1);
  });

  it('fans out with the block kind, the figure and an as-of instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    mockReadSnapshot.mockResolvedValue(onHold(27_500));

    await enforceBookingFunding(BASE_INPUT);

    expect(mockPublishNotificationEvent).toHaveBeenCalledTimes(1);
    const payload = lastPayload();
    expect(payload).toMatchObject({
      blockKind: 'account_on_hold',
      topUpNeededMinor: 27_500,
      asOfIso: NOW_ISO,
      requestedByUserId: USER_ID,
    });
    expect(Object.keys(payload)).not.toContain('reservedBookingCount');
  });

  it('logs the figures on the refusal line — the only place they are logged', async () => {
    mockReadSnapshot.mockResolvedValue(onHold(27_500));

    await enforceBookingFunding(BASE_INPUT);

    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking refused before any write — balance pre-condition unmet',
      expect.objectContaining({
        blockKind: 'account_on_hold',
        topUpNeededMinor: 27_500,
        reservedBookingCount: null,
      })
    );
  });

  it('analytics: reason account_on_hold, the exact key set, no reserved_booking_count and no money', async () => {
    mockReadSnapshot.mockResolvedValue(onHold(27_500));

    await enforceBookingFunding(BASE_INPUT);

    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    expect(lastAnalytics()).toMatchObject({ reason: 'account_on_hold', duration_minutes: 30 });
    expect(Object.keys(lastAnalytics()).sort((a, b) => a.localeCompare(b))).toEqual([
      'can_manage_billing',
      'distinct_id',
      'duration_minutes',
      'expert_id',
      'reason',
    ]);
  });

  describe('a covered hold (figure 0) — healed by the API, never shown', () => {
    it("'defer' passes the booking through to the API, logs info, and notifies nobody", async () => {
      mockReadSnapshot.mockResolvedValue(onHold(0));

      const result = await enforceBookingFunding({ ...BASE_INPUT, onCoveredHold: 'defer' });

      expect(result).toEqual({ ok: true });
      expect(mockLogInfo).toHaveBeenCalledWith(
        'A covered hold is still open — the booking API heals it before booking',
        expect.objectContaining({ companyId: COMPANY_ID })
      );
      expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    });

    it("'refuse' is the failed-heal fallback: topUpNeededMinor null, warn, fan-out with NO figure", async () => {
      mockReadSnapshot.mockResolvedValue(onHold(0));

      const result = await enforceBookingFunding({ ...BASE_INPUT, onCoveredHold: 'refuse' });

      expect(result).toEqual({
        ok: false,
        reason: 'on_hold',
        canManageBilling: false,
        billingCompany: { id: COMPANY_ID, name: 'Northwind Industrial', isActive: true },
        topUpNeededMinor: null,
      });
      expect(mockLogWarn).toHaveBeenCalledWith(
        'A covered hold could not be cleared by the booking API — showing the fallback',
        expect.objectContaining({ companyId: COMPANY_ID })
      );
      const payload = lastPayload();
      expect(payload).toMatchObject({ blockKind: 'account_on_hold' });
      // NEVER 0 — the fallback carries no figure and no as-of at all.
      expect(Object.keys(payload)).not.toContain('topUpNeededMinor');
      expect(Object.keys(payload)).not.toContain('asOfIso');
      expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('A$0.00');
    });
  });
});

describe('enforceBookingFunding — planned consultations set credit aside (D6.5)', () => {
  it('refuses with the top-up figure and the COUNT of planned consultations', async () => {
    mockReadSnapshot.mockResolvedValue(noMandate(30_000, [PLANNED_30_MIN]));
    mockHasCapability.mockResolvedValue(true);

    const result = await enforceBookingFunding(BASE_INPUT);

    // estimate 18,750 + reserved 18,750 − available 30,000 = 7,500.
    expect(result).toEqual({
      ok: false,
      reason: 'reserved',
      canManageBilling: true,
      billingCompany: { id: COMPANY_ID, name: 'Northwind Industrial', isActive: true },
      topUpNeededMinor: 7_500,
      reservedBookingCount: 1,
    });
  });

  it('exactly enough room after the reservation passes (the boundary)', async () => {
    mockReadSnapshot.mockResolvedValue(noMandate(ESTIMATE_30_MINOR * 2, [PLANNED_30_MIN]));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: true });
  });

  it('fans out with the count, the figure and the as-of instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    mockReadSnapshot.mockResolvedValue(noMandate(30_000, [PLANNED_30_MIN]));

    await enforceBookingFunding(BASE_INPUT);

    expect(lastPayload()).toMatchObject({
      blockKind: 'reserved_by_upcoming',
      topUpNeededMinor: 7_500,
      reservedBookingCount: 1,
      asOfIso: NOW_ISO,
    });
  });

  it('analytics: reason reserved_by_upcoming with the COUNT and no money property', async () => {
    mockReadSnapshot.mockResolvedValue(noMandate(30_000, [PLANNED_30_MIN]));

    await enforceBookingFunding(BASE_INPUT);

    expect(Object.keys(lastAnalytics()).sort((a, b) => a.localeCompare(b))).toEqual([
      'can_manage_billing',
      'distinct_id',
      'duration_minutes',
      'expert_id',
      'reason',
      'reserved_booking_count',
    ]);
    expect(lastAnalytics()).toMatchObject({
      reason: 'reserved_by_upcoming',
      reserved_booking_count: 1,
    });
  });

  it('a mandate company passes even with planned consultations (the card funds the rest)', async () => {
    mockReadSnapshot.mockResolvedValue({ kind: 'mandate', walletId: WALLET_ID });

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: true });
  });
});

describe('enforceBookingFunding — the correlationId carries the block kind', () => {
  it('the three refusal arms yield three DISTINCT correlationIds inside one hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    const snapshots: readonly BookingFundingSnapshot[] = [
      { kind: 'no_wallet' },
      onHold(27_500),
      noMandate(30_000, [PLANNED_30_MIN]),
    ];

    const correlationIds: string[] = [];
    for (const snapshot of snapshots) {
      mockPublishNotificationEvent.mockClear();
      mockReadSnapshot.mockResolvedValue(snapshot);
      await enforceBookingFunding(BASE_INPUT);
      correlationIds.push(lastPayload()['correlationId'] as string);
    }

    expect(correlationIds).toHaveLength(3);
    expect(new Set(correlationIds).size).toBe(3);
    expect(correlationIds.map((id) => id.split(':')[3])).toEqual([
      'unfunded',
      'account_on_hold',
      'reserved_by_upcoming',
    ]);
  });
});
