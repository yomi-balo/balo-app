import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PresenceFacts } from '@balo/shared/meetings';

const {
  mockFindProfileById,
  mockFindUser,
  mockFindMeeting,
  mockFactsByMeetingIds,
  mockPublish,
  mockTrackServer,
  mockLogError,
  mockLogInfo,
  mockLogWarn,
  mockGetMemberRole,
  mockAcquireWalletLock,
  mockReadHoldStatus,
  mockLastDailyDunningAt,
  mockStampDailyDunning,
  mockClearCoveredHold,
  mockCaptureException,
  mockTransaction,
  TX,
} = vi.hoisted(() => {
  const tx = { __tx: true };
  return {
    mockFindProfileById: vi.fn(),
    mockFindUser: vi.fn(),
    mockFindMeeting: vi.fn(),
    mockFactsByMeetingIds: vi.fn(),
    mockPublish: vi.fn(),
    mockTrackServer: vi.fn(),
    mockLogError: vi.fn(),
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
    mockGetMemberRole: vi.fn(),
    mockAcquireWalletLock: vi.fn(),
    mockReadHoldStatus: vi.fn(),
    mockLastDailyDunningAt: vi.fn(),
    mockStampDailyDunning: vi.fn(),
    mockClearCoveredHold: vi.fn(),
    mockCaptureException: vi.fn(),
    mockTransaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    TX: tx,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
vi.mock('@balo/db', () => ({
  acquireWalletLock: mockAcquireWalletLock,
  db: { transaction: mockTransaction },
  creditReceivablesRepository: {
    readHoldStatus: mockReadHoldStatus,
    lastDailyDunningAt: mockLastDailyDunningAt,
    stampDailyDunning: mockStampDailyDunning,
  },
  expertsRepository: { findProfileById: mockFindProfileById },
  usersRepository: { findById: mockFindUser },
  meetingsRepository: { findById: mockFindMeeting },
  meetingPresenceRepository: { factsByMeetingIds: mockFactsByMeetingIds },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  deriveIdempotencyKey: (input: { sessionId?: string }) =>
    `overdraft_settlement:${input.sessionId}`,
}));
vi.mock('../credit/receivable-coverage.js', () => ({ clearCoveredHold: mockClearCoveredHold }));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  SESSION_SERVER_EVENTS: {
    GRACE_ENTERED: 'grace_entered',
    GRACE_CEILING_HIT: 'grace_ceiling_hit',
    SESSION_SETTLED: 'session_settled',
    RECEIVABLE_OPENED: 'receivable_opened',
    RECEIVABLE_CLEARED: 'receivable_cleared',
  },
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));
// BAL-412 (D5) — pin the floor to the shipped default so this suite is independent of any
// real MEETING_NO_SHOW_FLOOR_MINUTES override in the environment it runs under.
vi.mock('../../config/billing-floor.js', () => ({
  resolveBillingFloorMinutes: () => 15,
}));

import {
  DUNNING_CADENCE_HOURS,
  claimHoldDunningNotice,
  healCoveredHoldNow,
  publishGraceEntered,
  publishHoldDunningNotice,
  publishLowBalance,
  publishNearWrap,
  publishPaymentCharged,
  publishPayoutRecorded,
  publishReceivableCleared,
  publishSessionMissedCall,
  publishSessionSettled,
  publishSettlementFailure,
  publishTopupNudge,
  trackCeilingHit,
} from './notify.js';

const NOW = new Date('2026-07-16T12:00:00.000Z');
const SESSION = {
  id: 'session_1',
  walletId: 'wallet_1',
  companyId: 'company_1',
  initiatingMemberId: 'user_1',
  expertProfileId: 'expert_1',
  openedBy: 'client',
  clientRateMinorPerMinute: 100,
  expertRateMinorPerMinute: 80,
  // BAL-412 (D6) — 42 min already drawn is past the 15-min floor, so the corrected runway
  // formula reduces exactly to the shipped `floor(balance/rate)` and the assertion below is
  // unchanged.
  connectedMinutes: 42,
  effectiveCeilingMinor: 15_000,
  graceBoundMinutes: 30,
  graceEnteredAt: new Date(NOW.getTime() - 5 * 60_000),
  overdraftSettledMinor: 1_200,
} as unknown as Parameters<typeof publishLowBalance>[0];

/** The same session, opened ON BEHALF of the booker (a guest admission or a terminal path). */
function onBehalf(
  overrides: Record<string, unknown> = {}
): Parameters<typeof publishLowBalance>[0] {
  return { ...SESSION, openedBy: 'system', ...overrides } as unknown as Parameters<
    typeof publishLowBalance
  >[0];
}

const SETTLEABLE = {
  id: 'session_1',
  companyId: 'company_1',
  walletId: 'wallet_1',
  expertProfileId: 'expert_1',
  overdraftSettledMinor: 1_200,
  openedBy: 'client',
} as const;

/** A hold status whose top-up figure is `amountToClearMinor`. */
function holdStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    onHold: true,
    openReceivableCount: 1,
    confirmationWasRequested: false,
    balanceMinor: -10_000,
    promoGrantedSinceDebtMinor: 0,
    amountToClearMinor: 10_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(TX));
  mockFindProfileById.mockResolvedValue({ userId: 'expert_user_1' });
  mockFindUser.mockResolvedValue({ firstName: 'Jordan', lastName: 'Ellis' });
  mockGetMemberRole.mockResolvedValue('member');
  mockLastDailyDunningAt.mockResolvedValue(undefined);
  mockStampDailyDunning.mockResolvedValue(['receivable_1']);
});

describe('notify helpers', () => {
  it('publishLowBalance carries the runway + rate', async () => {
    await publishLowBalance(SESSION, 500);
    expect(mockPublish).toHaveBeenCalledWith('session.low_balance', {
      correlationId: 'session_1:low_balance',
      sessionId: 'session_1',
      userId: 'user_1',
      companyId: 'company_1',
      minutesRemaining: 5,
      balanceMinor: 500,
      ratePerMinuteMinor: 100,
    });
  });

  it('publishLowBalance (BAL-412, D6) applies the floor correction early in a session', async () => {
    const early = { ...SESSION, connectedMinutes: 2 } as Parameters<typeof publishLowBalance>[0];
    // rate=100, floor=15, drawn=2, balance=2000 ⇒ unconsumed=13, committed=1300,
    // discretionary=700 ⇒ 7 min (the uncorrected formula would have said 20).
    await publishLowBalance(early, 2_000);
    expect(mockPublish).toHaveBeenCalledWith(
      'session.low_balance',
      expect.objectContaining({ minutesRemaining: 7 })
    );
  });

  it('publishGraceEntered publishes + tracks GRACE_ENTERED with the ceiling room', async () => {
    await publishGraceEntered(SESSION, -2_000, NOW);
    expect(mockPublish).toHaveBeenCalledWith(
      'session.grace_entered',
      expect.objectContaining({
        correlationId: 'session_1:grace_entered',
        userId: 'user_1',
        graceRemainingMinutes: 25,
        ceilingRoomMinor: 13_000,
      })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'grace_entered',
      expect.objectContaining({
        session_id: 'session_1',
        ceiling_room_minor: 13_000,
        distinct_id: 'company_1',
      })
    );
  });

  it('publishNearWrap carries the grace remaining', async () => {
    await publishNearWrap(SESSION, NOW);
    expect(mockPublish).toHaveBeenCalledWith(
      'session.near_wrap',
      expect.objectContaining({ correlationId: 'session_1:near_wrap', graceRemainingMinutes: 25 })
    );
  });

  it('trackCeilingHit reports the overdraft magnitude', () => {
    trackCeilingHit(SESSION, -3_000);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'grace_ceiling_hit',
      expect.objectContaining({ overdraft_minor: 3_000, distinct_id: 'company_1' })
    );
  });

  it('publishSessionSettled resolves the expert name + tracks success, with opened_by', async () => {
    await publishSessionSettled(SETTLEABLE, NOW);
    expect(mockPublish).toHaveBeenCalledWith(
      'session.settled',
      expect.objectContaining({
        expertName: 'Jordan Ellis',
        overdraftSettledMinor: 1_200,
        settledOn: '16 July 2026',
      })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'session_settled',
      expect.objectContaining({
        outcome: 'success',
        overdraft_settled_minor: 1_200,
        opened_by: 'client',
      })
    );
  });

  it('publishSessionSettled carries opened_by for an on-behalf session (BAL-474)', async () => {
    await publishSessionSettled({ ...SETTLEABLE, openedBy: 'guest' }, NOW);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'session_settled',
      expect.objectContaining({ opened_by: 'guest' })
    );
  });

  it('publishSessionSettled (BAL-412, D7) threads settlementShape into analytics ONLY, under its own key', async () => {
    await publishSessionSettled({ ...SETTLEABLE, overdraftSettledMinor: 0 }, NOW, 'no_show_client');
    // The NOTIFICATION payload is unaffected — `settlementShape` is analytics-only.
    const notifyPayload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(notifyPayload).not.toHaveProperty('settlementShape');
    expect(mockTrackServer).toHaveBeenCalledWith(
      'session_settled',
      expect.objectContaining({ outcome: 'success', settlement_outcome: 'no_show_client' })
    );
  });

  it('publishSessionSettled omits settlement_outcome when no shape is supplied (live_capture)', async () => {
    await publishSessionSettled({ ...SETTLEABLE, overdraftSettledMinor: 0 }, NOW);
    const analyticsCall = mockTrackServer.mock.calls.find((c) => c[0] === 'session_settled');
    expect(analyticsCall?.[1]).not.toHaveProperty('settlement_outcome');
  });

  it('publishSessionSettled degrades to "your expert" when the profile is missing', async () => {
    mockFindProfileById.mockResolvedValue(undefined);
    await publishSessionSettled(
      { ...SETTLEABLE, expertProfileId: 'gone', overdraftSettledMinor: 0 },
      NOW
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'session.settled',
      expect.objectContaining({ expertName: 'your expert', overdraftSettledMinor: 0 })
    );
  });

  it('publishTopupNudge publishes the nudge with the requester', async () => {
    await publishTopupNudge({ id: 'session_1', companyId: 'company_1' }, 'user_1', 'Dana', 42);
    expect(mockPublish).toHaveBeenCalledWith('session.topup_nudge', {
      correlationId: 'session_1:topup_nudge:42',
      sessionId: 'session_1',
      companyId: 'company_1',
      requestedByUserId: 'user_1',
      requestedByName: 'Dana',
    });
  });

  it('publishReceivableCleared (BAL-535) publishes ONE notice per clear operation, keyed on the operation id', async () => {
    await publishReceivableCleared({
      operationId: 'ledger_1',
      companyId: 'company_1',
      walletId: 'wallet_1',
      receivableCount: 3,
      clearedMinor: 1200,
      balanceAfterMinor: 300,
      clearedBy: 'manual_purchase',
    });
    // ⚠ N4 — the correlationId is the OPERATION (the ledger entry on a credit arm), not a receivable
    // id. Keying it per row sent three identical "your account is clear" emails for a wallet
    // holding three receivables.
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('credit.receivable.cleared', {
      correlationId: 'receivable_cleared:ledger_1',
      companyId: 'company_1',
      walletId: 'wallet_1',
      receivableCount: 3,
      clearedMinor: 1200,
      balanceAfterMinor: 300,
      clearedBy: 'manual_purchase',
    });
    expect(mockTrackServer).toHaveBeenCalledWith('receivable_cleared', {
      company_id: 'company_1',
      wallet_id: 'wallet_1',
      receivable_count: 3,
      cleared_minor: 1200,
      balance_after_minor: 300,
      cleared_by: 'manual_purchase',
      distinct_id: 'company_1',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('publishReceivableCleared takes the heal and the settlement arms as `clearedBy` (BAL-474, D8.4)', async () => {
    await publishReceivableCleared({
      operationId: 'receivable_9',
      companyId: 'company_1',
      walletId: 'wallet_1',
      receivableCount: 1,
      clearedMinor: 500,
      balanceAfterMinor: 0,
      clearedBy: 'coverage_heal',
    });
    expect(mockPublish).toHaveBeenCalledWith(
      'credit.receivable.cleared',
      expect.objectContaining({
        correlationId: 'receivable_cleared:receivable_9',
        clearedBy: 'coverage_heal',
      })
    );
  });

  it('publishReceivableCleared self-catches a publish failure and NEVER re-throws (money already committed)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(
      publishReceivableCleared({
        operationId: 'ledger_2',
        companyId: 'company_1',
        walletId: 'wallet_1',
        receivableCount: 1,
        clearedMinor: 500,
        balanceAfterMinor: 0,
        clearedBy: 'auto_topup',
      })
    ).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledTimes(1);
    const [fields] = mockLogError.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      op: 'publishReceivableCleared',
      operationId: 'ledger_2',
      companyId: 'company_1',
      walletId: 'wallet_1',
      receivableCount: 1,
    });
  });

  // ⚠ FIX ROUND L1 — the metric must survive a queue outage. `trackServer` used to sit INSIDE the
  // try wrapping the publish, so an outage lost the count as well as the email — while its pair
  // `RECEIVABLE_OPENED` sits on a throwing path and is never lost. §J's "how many holds clear
  // without ops touching them" would have counted opens reliably and clears short. Moving
  // `trackServer` back inside the try fails HERE.
  it('⚠ L1 — the RECEIVABLE_CLEARED metric still fires when the notification publish throws', async () => {
    mockPublish.mockRejectedValueOnce(new Error('queue unavailable'));
    await publishReceivableCleared({
      operationId: 'ledger_3',
      companyId: 'company_1',
      walletId: 'wallet_1',
      receivableCount: 1,
      clearedMinor: 500,
      balanceAfterMinor: 0,
      clearedBy: 'auto_topup',
    });
    expect(mockTrackServer).toHaveBeenCalledWith(
      'receivable_cleared',
      expect.objectContaining({ company_id: 'company_1', receivable_count: 1 })
    );
  });

  // …and the containment half: the metric sits OUTSIDE the publish try but inside its own, so an
  // analytics throw cannot escape into the post-commit loop (which has no try/catch of its own)
  // and make Stripe retry a COMMITTED webhook. Removing that inner try fails HERE.
  it('⚠ L1 — a throwing trackServer is contained; the notification still publishes', async () => {
    mockTrackServer.mockImplementationOnce(() => {
      throw new Error('posthog down');
    });
    await expect(
      publishReceivableCleared({
        operationId: 'ledger_4',
        companyId: 'company_1',
        walletId: 'wallet_1',
        receivableCount: 1,
        clearedMinor: 500,
        balanceAfterMinor: 0,
        clearedBy: 'auto_topup',
      })
    ).resolves.toBeUndefined();
    expect(mockPublish).toHaveBeenCalledWith(
      'credit.receivable.cleared',
      expect.objectContaining({ correlationId: 'receivable_cleared:ledger_4' })
    );
  });

  it('publishPaymentCharged carries the client all-in charge to the acting member (self)', async () => {
    // connectedMinutes × clientRateMinorPerMinute is the all-in — NO expert figure in the payload.
    const session = { ...SESSION, connectedMinutes: 45 } as unknown as Parameters<
      typeof publishPaymentCharged
    >[0];
    await publishPaymentCharged(session, NOW);
    expect(mockPublish).toHaveBeenCalledWith('payment.charged', {
      correlationId: 'session_1:payment_charged',
      userId: 'user_1',
      companyId: 'company_1',
      sessionId: 'session_1',
      amountAudMinor: 45 * 100,
      durationMinutes: 45,
      expertName: 'Jordan Ellis',
      chargedOn: '16 July 2026',
    });
    // No expert-earnings key anywhere in the payload (fee concealment).
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('expertAccruedMinor');
    expect(payload).not.toHaveProperty('baloFeeBps');
  });

  it('publishPayoutRecorded carries the expert own earnings to the expert', async () => {
    const session = {
      ...SESSION,
      connectedMinutes: 45,
      expertAccruedMinor: 3600,
    } as unknown as Parameters<typeof publishPayoutRecorded>[0];
    await publishPayoutRecorded(session, NOW);
    expect(mockPublish).toHaveBeenCalledWith('payout.recorded', {
      correlationId: 'session_1:payout_recorded',
      expertProfileId: 'expert_1',
      sessionId: 'session_1',
      amountAudMinor: 3600,
      durationMinutes: 45,
      recordedOn: '16 July 2026',
    });
    // No client rate / fee key anywhere in the payload (fee concealment) — amountAudMinor here
    // IS the expert's OWN earnings, not the client charge.
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('clientRateMinorPerMinute');
    expect(payload).not.toHaveProperty('baloFeeBps');
  });

  // ── BAL-412 (F16) — the presence-settlement CONTEXT on the two ordinary receipts ─────────
  //
  // ⚠ WITHOUT THIS, A `no_show_client` RECEIPT IS THE ORDINARY RECEIPT. These three optional
  // fields are the ONLY way the templates can tell a no-show apart, because `no_show_client`
  // settles through `payment.charged` / `payout.recorded` rather than through a bespoke event
  // the way `missed_call` does. Durations + a label only — never a second money figure, so the
  // SAME three fields are safe on both the client-lens and expert-lens payload.

  it('publishPaymentCharged carries the no-show settlement context (shape + actual + floor)', async () => {
    const session = {
      ...SESSION,
      connectedMinutes: 15,
      settlementShape: 'no_show_client',
      actualMinutes: 18,
      billingFloorMinutes: 15,
    } as unknown as Parameters<typeof publishPaymentCharged>[0];
    await publishPaymentCharged(session, NOW);
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      settlementShape: 'no_show_client',
      actualMinutes: 18,
      billingFloorMinutes: 15,
    });
    // Still fee-safe — the context adds a label and two DURATIONS, never a figure.
    expect(payload).not.toHaveProperty('expertAccruedMinor');
    expect(payload).not.toHaveProperty('baloFeeBps');
  });

  it('publishPayoutRecorded carries the same context to the expert (the AC accrual confirmation)', async () => {
    const session = {
      ...SESSION,
      connectedMinutes: 15,
      expertAccruedMinor: 1_200,
      settlementShape: 'no_show_client',
      actualMinutes: 18,
      billingFloorMinutes: 15,
    } as unknown as Parameters<typeof publishPayoutRecorded>[0];
    await publishPayoutRecorded(session, NOW);
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      settlementShape: 'no_show_client',
      actualMinutes: 18,
      billingFloorMinutes: 15,
    });
    expect(payload).not.toHaveProperty('clientRateMinorPerMinute');
  });

  it('a live_capture session (settlementShape NULL) omits all three — the shipped receipt is untouched', async () => {
    const session = {
      ...SESSION,
      connectedMinutes: 45,
      settlementShape: null,
      actualMinutes: null,
      billingFloorMinutes: null,
    } as unknown as Parameters<typeof publishPaymentCharged>[0];
    await publishPaymentCharged(session, NOW);
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('settlementShape');
    expect(payload).not.toHaveProperty('actualMinutes');
    expect(payload).not.toHaveProperty('billingFloorMinutes');
  });
});

/** `factsByMeetingIds`'s result for the missed meeting, with the client-side flag under test. */
function presenceFacts(clientSideEverPresent: boolean): Map<string, PresenceFacts> {
  return new Map([
    [
      'meeting_1',
      {
        expertEverPresent: false,
        expertOpen: false,
        clientSideEverPresent,
        anyOpen: false,
        lastLeftAt: null,
        expertFirstJoinedAt: null,
      },
    ],
  ]);
}

describe('publishSessionMissedCall (BAL-412, ADR-1044 §7, D8)', () => {
  const MISSED_CALL_SESSION = {
    ...SESSION,
    meetingId: 'meeting_1',
  } as unknown as Parameters<typeof publishSessionMissedCall>[0];

  beforeEach(() => {
    mockFindMeeting.mockResolvedValue({
      id: 'meeting_1',
      scheduledStart: new Date('2026-07-16T10:00:00.000Z'),
    });
    mockFactsByMeetingIds.mockResolvedValue(presenceFacts(true));
  });

  it('publishes ONE event carrying both recipients — no figure anywhere (nothing was charged)', async () => {
    await publishSessionMissedCall(MISSED_CALL_SESSION, NOW);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('session.missed_call', {
      correlationId: 'session_1:missed_call',
      sessionId: 'session_1',
      meetingId: 'meeting_1',
      userId: 'user_1',
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      expertName: 'Jordan Ellis',
      scheduledOn: '16 July 2026',
      clientSideEverPresent: true,
    });
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('amountAudMinor');
    expect(payload).not.toHaveProperty('overdraftSettledMinor');
  });

  it('reads presence for exactly the missed meeting, once', async () => {
    await publishSessionMissedCall(MISSED_CALL_SESSION, NOW);
    expect(mockFactsByMeetingIds).toHaveBeenCalledTimes(1);
    expect(mockFactsByMeetingIds).toHaveBeenCalledWith(['meeting_1']);
  });

  it('carries clientSideEverPresent: false when nobody on the client side ever joined', async () => {
    mockFactsByMeetingIds.mockResolvedValue(presenceFacts(false));
    await publishSessionMissedCall(MISSED_CALL_SESSION, NOW);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.clientSideEverPresent).toBe(false);
  });

  it('a failed presence read STILL publishes, with presence unknown (null), and logs the error', async () => {
    mockFactsByMeetingIds.mockRejectedValue(new Error('connection reset'));
    await expect(publishSessionMissedCall(MISSED_CALL_SESSION, NOW)).resolves.toBeUndefined();
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toHaveProperty('clientSideEverPresent', null);
    expect(payload.expertName).toBe('Jordan Ellis');
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'publishSessionMissedCall',
        sessionId: 'session_1',
        meetingId: 'meeting_1',
        error: 'connection reset',
        stack: expect.any(String),
      }),
      expect.any(String)
    );
  });

  it('a result missing the meeting degrades to null rather than guessing', async () => {
    mockFactsByMeetingIds.mockResolvedValue(new Map());
    await publishSessionMissedCall(MISSED_CALL_SESSION, NOW);
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toHaveProperty('clientSideEverPresent', null);
  });

  it('skips (no publish) when the session has no meetingId — defensively, should be unreachable', async () => {
    const session = {
      ...SESSION,
      meetingId: null,
    } as unknown as Parameters<typeof publishSessionMissedCall>[0];
    await publishSessionMissedCall(session, NOW);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockFindMeeting).not.toHaveBeenCalled();
    expect(mockFactsByMeetingIds).not.toHaveBeenCalled();
  });

  it('skips (no publish) when the meeting is not found', async () => {
    mockFindMeeting.mockResolvedValue(undefined);
    await publishSessionMissedCall(MISSED_CALL_SESSION, NOW);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockFactsByMeetingIds).not.toHaveBeenCalled();
  });
});

// ── BAL-474 (ADR-1040 Amendment 7 §C.3, D5.7) — a departed booker is never addressed ─────────

describe('booker-addressed notices for an on-behalf session (BAL-474, D5.7)', () => {
  it('a member-opened session never looks the membership up — the actor is the person in the call', async () => {
    await publishLowBalance(SESSION, 500);
    await publishNearWrap(SESSION, NOW);
    await publishPaymentCharged(SESSION, NOW);
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['publishLowBalance', (s: ReturnType<typeof onBehalf>) => publishLowBalance(s, 500)],
    ['publishNearWrap', (s: ReturnType<typeof onBehalf>) => publishNearWrap(s, NOW)],
    ['publishPaymentCharged', (s: ReturnType<typeof onBehalf>) => publishPaymentCharged(s, NOW)],
  ])('%s is SKIPPED (info log) for a booker who has left the company', async (_name, publish) => {
    mockGetMemberRole.mockResolvedValue(undefined);
    await publish(onBehalf());
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', 'company_1', 'user_1');
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session_1', openedBy: 'system' }),
      expect.stringContaining('no longer a member')
    );
  });

  it.each([
    ['publishLowBalance', (s: ReturnType<typeof onBehalf>) => publishLowBalance(s, 500)],
    ['publishNearWrap', (s: ReturnType<typeof onBehalf>) => publishNearWrap(s, NOW)],
    ['publishPaymentCharged', (s: ReturnType<typeof onBehalf>) => publishPaymentCharged(s, NOW)],
  ])('%s still publishes to a booker who is STILL a member', async (_name, publish) => {
    mockGetMemberRole.mockResolvedValue('member');
    await publish(onBehalf({ openedBy: 'guest' }));
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0]?.[1]).toMatchObject({ userId: 'user_1' });
  });

  it('publishGraceEntered omits userId for a departed booker — the billing-admin ping still goes out, and the analytics still fire', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    await publishGraceEntered(onBehalf(), -2_000, NOW);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0]?.[1]).not.toHaveProperty('userId');
    expect(mockPublish.mock.calls[0]?.[1]).toMatchObject({ companyId: 'company_1' });
    expect(mockTrackServer).toHaveBeenCalledWith('grace_entered', expect.anything());
  });

  it('publishGraceEntered keeps userId for a booker who is still a member', async () => {
    await publishGraceEntered(onBehalf(), -2_000, NOW);
    expect(mockPublish.mock.calls[0]?.[1]).toMatchObject({ userId: 'user_1' });
  });

  it('publishSessionMissedCall omits userId for a departed booker — the expert is still told', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    mockFindMeeting.mockResolvedValue({
      id: 'meeting_1',
      scheduledStart: new Date('2026-07-16T10:00:00.000Z'),
    });
    mockFactsByMeetingIds.mockResolvedValue(presenceFacts(true));
    await publishSessionMissedCall(onBehalf({ meetingId: 'meeting_1' }), NOW);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('userId');
    expect(payload).toMatchObject({ expertProfileId: 'expert_1', clientSideEverPresent: true });
  });

  it('a role with no PARTICIPATE capability counts as departed (defensive — an unknown role fails closed)', async () => {
    mockGetMemberRole.mockResolvedValue('not_a_company_role');
    await publishLowBalance(onBehalf(), 500);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

// ── BAL-474 (ADR-1040 Amendment 7 §G, D6.2, D7.1, D7.2) — wallet-grain hold dunning ─────────

describe('claimHoldDunningNotice (BAL-474)', () => {
  it('takes the wallet advisory lock FIRST, then reads the hold status on the SAME transaction', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    await claimHoldDunningNotice({ walletId: 'wallet_1', trigger: 'receivable_opened', now: NOW });
    expect(mockAcquireWalletLock).toHaveBeenCalledWith(TX, 'wallet_1');
    expect(mockReadHoldStatus).toHaveBeenCalledWith({ walletId: 'wallet_1' }, TX);
    expect(mockAcquireWalletLock.mock.invocationCallOrder[0]).toBeLessThan(
      mockReadHoldStatus.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('not_on_hold: the hold cleared since the sweep listed the wallet — nothing to say, nothing stamped', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ onHold: false, amountToClearMinor: 0 }));
    const claim = await claimHoldDunningNotice({
      walletId: 'wallet_1',
      trigger: 'daily_reminder',
      now: NOW,
    });
    expect(claim).toEqual({ kind: 'not_on_hold' });
    expect(mockStampDailyDunning).not.toHaveBeenCalled();
    expect(mockClearCoveredHold).not.toHaveBeenCalled();
  });

  it('healed: a covered-but-held wallet (figure 0) is HEALED through the coverage module, never claimed', async () => {
    const status = holdStatus({ balanceMinor: 0, amountToClearMinor: 0 });
    mockReadHoldStatus.mockResolvedValue(status);
    const healed = {
      clearedIds: ['receivable_1'],
      clearedMinor: 10_000,
      companyId: 'company_1',
      balanceMinor: 0,
    };
    mockClearCoveredHold.mockResolvedValue(healed);
    const claim = await claimHoldDunningNotice({
      walletId: 'wallet_1',
      trigger: 'daily_reminder',
      now: NOW,
    });
    expect(claim).toEqual({ kind: 'healed', healed });
    expect(mockClearCoveredHold).toHaveBeenCalledTimes(1);
    expect(mockClearCoveredHold).toHaveBeenCalledWith(TX, {
      walletId: 'wallet_1',
      balanceMinor: 0,
      trigger: 'dunning_claim',
      now: NOW,
    });
    expect(mockStampDailyDunning).not.toHaveBeenCalled();
  });

  it('daily_reminder: stamps the cadence in the SAME transaction and claims the figure', async () => {
    const status = holdStatus();
    mockReadHoldStatus.mockResolvedValue(status);
    const claim = await claimHoldDunningNotice({
      walletId: 'wallet_1',
      trigger: 'daily_reminder',
      now: NOW,
    });
    expect(claim).toEqual({ kind: 'claimed', status });
    expect(mockLastDailyDunningAt).toHaveBeenCalledWith('wallet_1', TX);
    expect(mockStampDailyDunning).toHaveBeenCalledWith('wallet_1', NOW, TX);
  });

  it('already_reminded: another sweep stamped this wallet inside the cadence — no second stamp, no second notice', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    mockLastDailyDunningAt.mockResolvedValue(
      new Date(NOW.getTime() - (DUNNING_CADENCE_HOURS - 1) * 60 * 60 * 1000)
    );
    const claim = await claimHoldDunningNotice({
      walletId: 'wallet_1',
      trigger: 'daily_reminder',
      now: NOW,
    });
    expect(claim).toEqual({ kind: 'already_reminded' });
    expect(mockStampDailyDunning).not.toHaveBeenCalled();
  });

  it('a stamp OLDER than the cadence does not block the daily reminder', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    mockLastDailyDunningAt.mockResolvedValue(
      new Date(NOW.getTime() - (DUNNING_CADENCE_HOURS + 1) * 60 * 60 * 1000)
    );
    const claim = await claimHoldDunningNotice({
      walletId: 'wallet_1',
      trigger: 'daily_reminder',
      now: NOW,
    });
    expect(claim.kind).toBe('claimed');
    expect(mockStampDailyDunning).toHaveBeenCalledTimes(1);
  });

  it('⚠ D7.1 — a receivable_opened notice is NEVER throttled and NEVER stamps, even inside the cadence', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    mockLastDailyDunningAt.mockResolvedValue(new Date(NOW.getTime() - 60_000));
    const claim = await claimHoldDunningNotice({
      walletId: 'wallet_1',
      trigger: 'receivable_opened',
      now: NOW,
    });
    expect(claim.kind).toBe('claimed');
    expect(mockLastDailyDunningAt).not.toHaveBeenCalled();
    expect(mockStampDailyDunning).not.toHaveBeenCalled();
  });
});

describe('healCoveredHoldNow (BAL-474, D8.1)', () => {
  it('heals a covered hold under the wallet lock and publishes ONE account-clear keyed on the first cleared receivable id', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ balanceMinor: 0, amountToClearMinor: 0 }));
    mockClearCoveredHold.mockResolvedValue({
      clearedIds: ['receivable_1', 'receivable_2'],
      clearedMinor: 24_000,
      companyId: 'company_1',
      balanceMinor: 0,
    });
    await expect(
      healCoveredHoldNow({ walletId: 'wallet_1', trigger: 'booking_guard', now: NOW })
    ).resolves.toEqual({ healed: true });
    expect(mockAcquireWalletLock).toHaveBeenCalledWith(TX, 'wallet_1');
    expect(mockClearCoveredHold).toHaveBeenCalledWith(TX, {
      walletId: 'wallet_1',
      balanceMinor: 0,
      trigger: 'booking_guard',
      now: NOW,
    });
    expect(mockPublish).toHaveBeenCalledWith('credit.receivable.cleared', {
      correlationId: 'receivable_cleared:receivable_1',
      companyId: 'company_1',
      walletId: 'wallet_1',
      receivableCount: 2,
      clearedMinor: 24_000,
      balanceAfterMinor: 0,
      clearedBy: 'coverage_heal',
    });
  });

  it('is a no-op when the wallet is not on hold', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ onHold: false, amountToClearMinor: 0 }));
    await expect(
      healCoveredHoldNow({ walletId: 'wallet_1', trigger: 'booking_guard', now: NOW })
    ).resolves.toEqual({ healed: false });
    expect(mockClearCoveredHold).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('is a no-op when the hold is NOT covered (a real figure > 0) — it never clears a live debt', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    await expect(
      healCoveredHoldNow({ walletId: 'wallet_1', trigger: 'booking_guard', now: NOW })
    ).resolves.toEqual({ healed: false });
    expect(mockClearCoveredHold).not.toHaveBeenCalled();
  });

  it('reports healed: false — and publishes nothing — when the coverage module cleared nothing', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ balanceMinor: 0, amountToClearMinor: 0 }));
    mockClearCoveredHold.mockResolvedValue({
      clearedIds: [],
      clearedMinor: 0,
      companyId: undefined,
      balanceMinor: 0,
    });
    await expect(
      healCoveredHoldNow({ walletId: 'wallet_1', trigger: 'booking_guard', now: NOW })
    ).resolves.toEqual({ healed: false });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('propagates a failure of the heal — the booking guard treats a throw as a failed heal', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ balanceMinor: 0, amountToClearMinor: 0 }));
    mockClearCoveredHold.mockRejectedValue(new Error('db down'));
    await expect(
      healCoveredHoldNow({ walletId: 'wallet_1', trigger: 'booking_guard', now: NOW })
    ).rejects.toThrow('db down');
  });

  it('⚠ D8.4 — two heals on one wallet get two DISTINCT correlationIds', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ balanceMinor: 0, amountToClearMinor: 0 }));
    mockClearCoveredHold
      .mockResolvedValueOnce({
        clearedIds: ['receivable_a'],
        clearedMinor: 10_000,
        companyId: 'company_1',
        balanceMinor: 0,
      })
      .mockResolvedValueOnce({
        clearedIds: ['receivable_b'],
        clearedMinor: 14_000,
        companyId: 'company_1',
        balanceMinor: 0,
      });
    await healCoveredHoldNow({ walletId: 'wallet_1', trigger: 'booking_guard', now: NOW });
    await healCoveredHoldNow({ walletId: 'wallet_1', trigger: 'booking_guard', now: NOW });
    const ids = mockPublish.mock.calls.map(
      (call) => (call[1] as { correlationId: string }).correlationId
    );
    expect(ids).toEqual(['receivable_cleared:receivable_a', 'receivable_cleared:receivable_b']);
  });
});

describe('publishHoldDunningNotice (BAL-474)', () => {
  const base = {
    walletId: 'wallet_1',
    companyId: 'company_1',
    trigger: 'receivable_opened',
    correlationKey: 'receivable_1',
    now: NOW,
  } as const;

  it('publishes ONE wallet-grain notice quoting the top-up figure from the claim, dated', async () => {
    mockReadHoldStatus.mockResolvedValue(
      holdStatus({
        amountToClearMinor: 29_000,
        promoGrantedSinceDebtMinor: 5_000,
        confirmationWasRequested: true,
      })
    );
    await expect(publishHoldDunningNotice(base)).resolves.toBe('published');
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('session.settlement_failed', {
      correlationId: 'hold_dunning:receivable_1',
      companyId: 'company_1',
      walletId: 'wallet_1',
      topUpNeededMinor: 29_000,
      promoGrantedSinceDebtMinor: 5_000,
      confirmationWasRequested: true,
      asOfIso: NOW.toISOString(),
      trigger: 'receivable_opened',
    });
  });

  it('the daily arm keys the notice per write: hold_dunning:{key} carries the trigger', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    await publishHoldDunningNotice({
      ...base,
      trigger: 'daily_reminder',
      correlationKey: 'wallet_1:1700000000000',
    });
    expect(mockPublish).toHaveBeenCalledWith(
      'session.settlement_failed',
      expect.objectContaining({
        correlationId: 'hold_dunning:wallet_1:1700000000000',
        trigger: 'daily_reminder',
      })
    );
  });

  it('publishes nothing when the wallet is no longer on hold', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ onHold: false, amountToClearMinor: 0 }));
    await expect(publishHoldDunningNotice(base)).resolves.toBe('not_on_hold');
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet_1' }),
      expect.stringContaining('no longer on hold')
    );
  });

  it('publishes nothing when another sweep already reminded the wallet inside the cadence', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    mockLastDailyDunningAt.mockResolvedValue(new Date(NOW.getTime() - 60_000));
    await expect(publishHoldDunningNotice({ ...base, trigger: 'daily_reminder' })).resolves.toBe(
      'already_reminded'
    );
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('a covered hold is healed and announced as an account clear — never dunned for A$0.00', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ balanceMinor: 0, amountToClearMinor: 0 }));
    mockClearCoveredHold.mockResolvedValue({
      clearedIds: ['receivable_1'],
      clearedMinor: 10_000,
      companyId: 'company_1',
      balanceMinor: 0,
    });
    await expect(publishHoldDunningNotice(base)).resolves.toBe('healed');
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'credit.receivable.cleared',
      expect.objectContaining({
        correlationId: 'receivable_cleared:receivable_1',
        clearedBy: 'coverage_heal',
      })
    );
    expect(mockPublish).not.toHaveBeenCalledWith('session.settlement_failed', expect.anything());
  });

  it('a publish failure is logged (error + Sentry) and NOT thrown — the claim stands', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    const failure = new Error('queue unavailable');
    mockPublish.mockRejectedValueOnce(failure);
    await expect(publishHoldDunningNotice({ ...base, trigger: 'daily_reminder' })).resolves.toBe(
      'publish_failed'
    );
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet_1', error: 'queue unavailable' }),
      expect.stringContaining('Failed to publish the hold dunning notice')
    );
    expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything());
    // The daily stamp was written inside the claim and is not rolled back by the lost publish.
    expect(mockStampDailyDunning).toHaveBeenCalledTimes(1);
  });

  it('a database fault in the claim itself propagates to the caller (the sweep isolates it per wallet)', async () => {
    mockAcquireWalletLock.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(publishHoldDunningNotice(base)).rejects.toThrow('lock timeout');
  });
});

describe('publishSettlementFailure (BAL-474 — never throttled, wallet grain)', () => {
  it('tracks the PER-SESSION analytics (with opened_by), then publishes the wallet-grain notice for THIS receivable', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus({ amountToClearMinor: 900 }));
    await publishSettlementFailure({
      session: {
        id: 'session_1',
        companyId: 'company_1',
        walletId: 'wallet_1',
        openedBy: 'system',
      },
      reason: 'declined',
      amountMinor: 900,
      receivableId: 'receivable_1',
      now: NOW,
    });
    expect(mockTrackServer).toHaveBeenCalledWith(
      'session_settled',
      expect.objectContaining({
        outcome: 'fail',
        opened_by: 'system',
        overdraft_settled_minor: 900,
      })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'receivable_opened',
      expect.objectContaining({ reason: 'settlement_declined', amount_minor: 900 })
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'session.settlement_failed',
      expect.objectContaining({
        correlationId: 'hold_dunning:receivable_1',
        trigger: 'receivable_opened',
        topUpNeededMinor: 900,
      })
    );
    // Never throttled: a new debt does not consult the daily cadence at all.
    expect(mockLastDailyDunningAt).not.toHaveBeenCalled();
    expect(mockStampDailyDunning).not.toHaveBeenCalled();
  });

  it('maps a requires_action outcome + receivable reason', async () => {
    mockReadHoldStatus.mockResolvedValue(holdStatus());
    await publishSettlementFailure({
      session: {
        id: 'session_1',
        companyId: 'company_1',
        walletId: 'wallet_1',
        openedBy: 'client',
      },
      reason: 'requires_action',
      amountMinor: 900,
      receivableId: 'receivable_1',
      now: NOW,
    });
    expect(mockTrackServer).toHaveBeenCalledWith(
      'session_settled',
      expect.objectContaining({ outcome: 'requires_action', opened_by: 'client' })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'receivable_opened',
      expect.objectContaining({ reason: 'settlement_requires_action' })
    );
  });

  it('the analytics fire even when the notice claim throws — a database fault cannot lose the metric', async () => {
    mockAcquireWalletLock.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(
      publishSettlementFailure({
        session: {
          id: 'session_1',
          companyId: 'company_1',
          walletId: 'wallet_1',
          openedBy: 'client',
        },
        reason: 'declined',
        amountMinor: 900,
        receivableId: 'receivable_1',
        now: NOW,
      })
    ).rejects.toThrow('lock timeout');
    expect(mockTrackServer).toHaveBeenCalledWith('receivable_opened', expect.anything());
  });
});
