import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindByCompanyId = vi.fn();
const mockGetAvailableBalance = vi.fn();
const mockFindRateCentsById = vi.fn();
const mockHasCapability = vi.fn();
const mockLogWarn = vi.fn();
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
  creditWalletsRepository: {
    findByCompanyId: (...args: unknown[]) => mockFindByCompanyId(...args),
  },
  creditHoldsRepository: {
    getAvailableBalance: (...args: unknown[]) => mockGetAvailableBalance(...args),
  },
  expertsRepository: {
    findRateCentsById: (...args: unknown[]) => mockFindRateCentsById(...args),
  },
}));
vi.mock('@/lib/authz', () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
  CAPABILITIES: { MANAGE_BILLING: 'manage_billing' },
}));
vi.mock('@/lib/logging', () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
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

import { enforceBookingFunding } from './booking-funding-gate';

const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';

const BASE_INPUT = {
  actorUserId: USER_ID,
  actorDisplayName: 'Dana Okoro',
  companyId: COMPANY_ID,
  expertProfileId: EXPERT_PROFILE_ID,
  estimatedMinutes: 30,
};

const ACTIVE_MANDATE_WALLET = {
  id: 'wallet-1',
  mandateStatus: 'active',
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
};

const NO_MANDATE_WALLET = {
  id: 'wallet-1',
  mandateStatus: null,
  stripeCustomerId: null,
  stripePaymentMethodId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockHasCapability.mockResolvedValue(false);
  mockResolveBookingExpertDisplay.mockResolvedValue({
    firstName: 'Dana',
    lastName: 'Okoro',
    partyLabel: 'CloudPeak',
  });
});

afterEach(() => {
  // REV-5 — restored here, not in the test body, so a failure mid-test can't leak fake timers
  // into the next test.
  vi.useRealTimers();
});

describe('enforceBookingFunding', () => {
  it('mandate arm alone: passes with NO further reads', async () => {
    mockFindByCompanyId.mockResolvedValue({ ...ACTIVE_MANDATE_WALLET, balanceMinor: 0 });

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: true });
    expect(mockGetAvailableBalance).not.toHaveBeenCalled();
    expect(mockFindRateCentsById).not.toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('balance arm alone: exactly-equal available passes (the >= boundary)', async () => {
    mockFindByCompanyId.mockResolvedValue(NO_MANDATE_WALLET);
    mockFindRateCentsById.mockResolvedValue({ rateCents: 30_000 });
    mockGetAvailableBalance.mockResolvedValue(18_750); // 30min @ A$375/hr client rate

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: true });
  });

  it('one minor short of the estimate refuses, reason no_mandate_insufficient_balance', async () => {
    mockFindByCompanyId.mockResolvedValue(NO_MANDATE_WALLET);
    mockFindRateCentsById.mockResolvedValue({ rateCents: 30_000 });
    mockGetAvailableBalance.mockResolvedValue(18_749);

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'booking_funding_blocked',
      expect.objectContaining({ reason: 'no_mandate_insufficient_balance' })
    );
  });

  /**
   * REV-2 — `estimateMinor`/`availableMinor` are the ONLY place the shortfall exists (panel,
   * email, in-app and PostHog all deliberately carry no figure).
   */
  it('REV-2 — the refusal log line carries the exact estimate and available figures', async () => {
    mockFindByCompanyId.mockResolvedValue(NO_MANDATE_WALLET);
    mockFindRateCentsById.mockResolvedValue({ rateCents: 30_000 });
    mockGetAvailableBalance.mockResolvedValue(18_749);

    await enforceBookingFunding(BASE_INPUT);

    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking refused before any write — funding pre-condition unmet',
      expect.objectContaining({ estimateMinor: 18_750, availableMinor: 18_749 })
    );
  });

  it('R4 — a mandate_status active with a null Stripe id is NOT an active mandate (conjunction, not a bare column compare)', async () => {
    mockFindByCompanyId.mockResolvedValue({
      id: 'wallet-1',
      mandateStatus: 'active',
      stripeCustomerId: null,
      stripePaymentMethodId: 'pm_1',
      balanceMinor: 0,
    });
    mockFindRateCentsById.mockResolvedValue({ rateCents: 30_000 });
    mockGetAvailableBalance.mockResolvedValue(0);

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('unfunded');
  });

  it('R5 — no wallet row: refuses with no_wallet, no further reads, does not throw', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockGetAvailableBalance).not.toHaveBeenCalled();
    expect(mockFindRateCentsById).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'booking_funding_blocked',
      expect.objectContaining({ reason: 'no_wallet' })
    );
  });

  it('§4.3 — a rate-less expert passes (unevaluable, not a refusal) and logs a warning', async () => {
    mockFindByCompanyId.mockResolvedValue(NO_MANDATE_WALLET);
    mockFindRateCentsById.mockResolvedValue({ rateCents: null });

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: true });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking funding pre-check skipped — expert has no rate',
      expect.objectContaining({ expertProfileId: EXPERT_PROFILE_ID })
    );
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  /**
   * SEC-3 — an UNKNOWN, client-supplied `expertProfileId` is NOT the §4.3 rate-less case: it
   * has no owner and no reason to pass. Fails closed as `'unavailable'`, distinct from the
   * positive control immediately below (a KNOWN, rate-less expert, which still passes).
   */
  it('SEC-3 — an unknown expert profile fails CLOSED as unavailable, distinct from a rate-less one', async () => {
    mockFindByCompanyId.mockResolvedValue(NO_MANDATE_WALLET);
    mockFindRateCentsById.mockResolvedValue(undefined);

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('a read throwing fails CLOSED — unavailable, logged, and publishes NOTHING', async () => {
    mockFindByCompanyId.mockRejectedValue(new Error('connection reset'));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Booking funding pre-check read failed — failing CLOSED',
      expect.objectContaining({ userId: USER_ID, companyId: COMPANY_ID })
    );
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  /**
   * SEC-1 / REV-3 — a blip in `hasCapability` AFTER the zero-arm is already determined must
   * NOT re-classify the refusal as `'unavailable'` (which would also silently skip the fan-out).
   * Orchestrator ruling: treat a failed capability read as a NON-holder.
   */
  it('SEC-1 — a hasCapability rejection is treated as non-holder, NOT re-classified as unavailable', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);
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
   * (Axiom + Sentry) and swallowed; the refusal is still returned.
   */
  it('REV-3 — a publish failure is logged to Sentry and swallowed; the refusal is still returned', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockResolveBookingExpertDisplay.mockRejectedValue(new Error('expert display blew up'));

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockLogError).toHaveBeenCalledWith(
      'Booking funding blocked fan-out failed to publish',
      expect.objectContaining({ companyId: COMPANY_ID })
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('the fan-out promise: publishes booking.funding_blocked with an hour-bucketed correlationId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:15:00.000Z'));
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockHasCapability.mockResolvedValue(false);

    const result = await enforceBookingFunding(BASE_INPUT);

    const expectedBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: false });
    expect(mockPublishNotificationEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.funding_blocked',
      expect.objectContaining({
        correlationId: `booking-funding:${COMPANY_ID}:${USER_ID}:${expectedBucket}`,
        companyId: COMPANY_ID,
        requestedByName: 'Dana Okoro',
        expertPartyLabel: 'CloudPeak',
      })
    );
  });

  it('self-serve branch: canManageBilling true, publish STILL happens (unconditional)', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockHasCapability.mockResolvedValue(true);

    const result = await enforceBookingFunding(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'unfunded', canManageBilling: true });
    expect(mockPublishNotificationEvent).toHaveBeenCalledTimes(1);
  });

  /**
   * REV-4 — pin `hasCapability`'s ARGUMENTS. R6 hangs entirely on this call: today a wrong
   * scope discriminant (`{ agencyId }`) or a wrong capability token would still pass every
   * other assertion in this file.
   */
  it('REV-4 — hasCapability is called with the exact actor, capability token and COMPANY scope', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);

    await enforceBookingFunding(BASE_INPUT);

    expect(mockHasCapability).toHaveBeenCalledWith({ id: USER_ID }, 'manage_billing', {
      companyId: COMPANY_ID,
    });
  });

  it('analytics: fires exactly once on the zero-arm with the exact key set and no money property', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockHasCapability.mockResolvedValue(false);

    await enforceBookingFunding(BASE_INPUT);

    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    const [, properties] = mockTrackServerAndFlush.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(properties).sort()).toEqual([
      'can_manage_billing',
      'distinct_id',
      'duration_minutes',
      'expert_id',
      'reason',
    ]);
  });

  it('positive control: the funded path fires NO analytics and NO publish (mutation proof for the two "not called" assertions above)', async () => {
    mockFindByCompanyId.mockResolvedValue({ ...ACTIVE_MANDATE_WALLET, balanceMinor: 0 });

    await enforceBookingFunding(BASE_INPUT);

    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });
});
