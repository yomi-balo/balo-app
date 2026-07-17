import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindProfileById, mockFindUser, mockPublish, mockTrackServer } = vi.hoisted(() => ({
  mockFindProfileById: vi.fn(),
  mockFindUser: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { findProfileById: mockFindProfileById },
  usersRepository: { findById: mockFindUser },
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

import {
  publishGraceEntered,
  publishLowBalance,
  publishNearWrap,
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
});
