import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindProfileById, mockFindUser, mockFindMeeting, mockPublish, mockTrackServer } =
  vi.hoisted(() => ({
    mockFindProfileById: vi.fn(),
    mockFindUser: vi.fn(),
    mockFindMeeting: vi.fn(),
    mockPublish: vi.fn(),
    mockTrackServer: vi.fn(),
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  expertsRepository: { findProfileById: mockFindProfileById },
  usersRepository: { findById: mockFindUser },
  meetingsRepository: { findById: mockFindMeeting },
  deriveIdempotencyKey: (input: { sessionId?: string }) =>
    `overdraft_settlement:${input.sessionId}`,
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  SESSION_SERVER_EVENTS: {
    GRACE_ENTERED: 'grace_entered',
    GRACE_CEILING_HIT: 'grace_ceiling_hit',
    SESSION_SETTLED: 'session_settled',
    RECEIVABLE_OPENED: 'receivable_opened',
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
  publishGraceEntered,
  publishLowBalance,
  publishNearWrap,
  publishPaymentCharged,
  publishPayoutRecorded,
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

describe('notify helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProfileById.mockResolvedValue({ userId: 'expert_user_1' });
    mockFindUser.mockResolvedValue({ firstName: 'Jordan', lastName: 'Ellis' });
  });

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

  it('publishSessionSettled resolves the expert name + tracks success', async () => {
    await publishSessionSettled(
      {
        id: 'session_1',
        companyId: 'company_1',
        walletId: 'wallet_1',
        expertProfileId: 'expert_1',
        overdraftSettledMinor: 1_200,
      },
      NOW
    );
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
      expect.objectContaining({ outcome: 'success', overdraft_settled_minor: 1_200 })
    );
  });

  it('publishSessionSettled (BAL-412, D7) threads settlementShape into analytics ONLY, under its own key', async () => {
    await publishSessionSettled(
      {
        id: 'session_1',
        companyId: 'company_1',
        walletId: 'wallet_1',
        expertProfileId: 'expert_1',
        overdraftSettledMinor: 0,
      },
      NOW,
      'no_show_client'
    );
    // The NOTIFICATION payload is unaffected — `settlementShape` is analytics-only.
    const notifyPayload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(notifyPayload).not.toHaveProperty('settlementShape');
    expect(mockTrackServer).toHaveBeenCalledWith(
      'session_settled',
      expect.objectContaining({ outcome: 'success', settlement_outcome: 'no_show_client' })
    );
  });

  it('publishSessionSettled omits settlement_outcome when no shape is supplied (live_capture)', async () => {
    await publishSessionSettled(
      {
        id: 'session_1',
        companyId: 'company_1',
        walletId: 'wallet_1',
        expertProfileId: 'expert_1',
        overdraftSettledMinor: 0,
      },
      NOW
    );
    const analyticsCall = mockTrackServer.mock.calls.find((c) => c[0] === 'session_settled');
    expect(analyticsCall?.[1]).not.toHaveProperty('settlement_outcome');
  });

  it('publishSessionSettled degrades to "your expert" when the profile is missing', async () => {
    mockFindProfileById.mockResolvedValue(undefined);
    await publishSessionSettled(
      {
        id: 'session_1',
        companyId: 'company_1',
        walletId: 'wallet_1',
        expertProfileId: 'gone',
        overdraftSettledMinor: 0,
      },
      NOW
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'session.settled',
      expect.objectContaining({ expertName: 'your expert', overdraftSettledMinor: 0 })
    );
  });

  it('publishSettlementFailure publishes + tracks SESSION_SETTLED{fail} + RECEIVABLE_OPENED', async () => {
    await publishSettlementFailure({
      session: { id: 'session_1', companyId: 'company_1', walletId: 'wallet_1' },
      reason: 'declined',
      amountMinor: 900,
      attemptEpochMs: 1_700_000_000_000,
    });
    expect(mockPublish).toHaveBeenCalledWith(
      'session.settlement_failed',
      expect.objectContaining({
        correlationId: 'session_1:settlement_failed:1700000000000',
        reason: 'declined',
        amountMinor: 900,
      })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'session_settled',
      expect.objectContaining({ outcome: 'fail' })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'receivable_opened',
      expect.objectContaining({ reason: 'settlement_declined', amount_minor: 900 })
    );
  });

  it('publishSettlementFailure maps requires_action outcome + receivable reason', async () => {
    await publishSettlementFailure({
      session: { id: 'session_1', companyId: 'company_1', walletId: 'wallet_1' },
      reason: 'requires_action',
      amountMinor: 900,
      attemptEpochMs: 1,
    });
    expect(mockTrackServer).toHaveBeenCalledWith(
      'session_settled',
      expect.objectContaining({ outcome: 'requires_action' })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'receivable_opened',
      expect.objectContaining({ reason: 'settlement_requires_action' })
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

describe('publishSessionMissedCall (BAL-412, ADR-1044 §7, D8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProfileById.mockResolvedValue({ userId: 'expert_user_1' });
    mockFindUser.mockResolvedValue({ firstName: 'Jordan', lastName: 'Ellis' });
    mockFindMeeting.mockResolvedValue({
      id: 'meeting_1',
      scheduledStart: new Date('2026-07-16T10:00:00.000Z'),
    });
  });

  it('publishes ONE event carrying both recipients — no figure anywhere (nothing was charged)', async () => {
    const session = {
      ...SESSION,
      meetingId: 'meeting_1',
    } as unknown as Parameters<typeof publishSessionMissedCall>[0];
    await publishSessionMissedCall(session, NOW);
    expect(mockPublish).toHaveBeenCalledWith('session.missed_call', {
      correlationId: 'session_1:missed_call',
      sessionId: 'session_1',
      meetingId: 'meeting_1',
      userId: 'user_1',
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      expertName: 'Jordan Ellis',
      scheduledOn: '16 July 2026',
    });
    const payload = mockPublish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('amountAudMinor');
    expect(payload).not.toHaveProperty('overdraftSettledMinor');
  });

  it('skips (no publish) when the session has no meetingId — defensively, should be unreachable', async () => {
    const session = {
      ...SESSION,
      meetingId: null,
    } as unknown as Parameters<typeof publishSessionMissedCall>[0];
    await publishSessionMissedCall(session, NOW);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockFindMeeting).not.toHaveBeenCalled();
  });

  it('skips (no publish) when the meeting is not found', async () => {
    mockFindMeeting.mockResolvedValue(undefined);
    const session = {
      ...SESSION,
      meetingId: 'meeting_1',
    } as unknown as Parameters<typeof publishSessionMissedCall>[0];
    await publishSessionMissedCall(session, NOW);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
