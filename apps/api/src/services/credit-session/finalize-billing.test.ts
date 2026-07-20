import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRecord, mockTrackServer, mockPublishPaymentCharged, mockPublishPayoutRecorded } =
  vi.hoisted(() => ({
    mockRecord: vi.fn(),
    mockTrackServer: vi.fn(),
    mockPublishPaymentCharged: vi.fn(),
    mockPublishPayoutRecorded: vi.fn(),
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  expertPayoutRecordsRepository: { record: mockRecord },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CASE_BILLING_SERVER_EVENTS: {
    CASE_BILLING_FINALIZED: 'case_billing_finalized',
    CASE_OVERDRAFT_GRACE_USED: 'case_overdraft_grace_used',
    EXPERT_PAYOUT_RECORDED: 'expert_payout_recorded',
  },
}));
vi.mock('./notify.js', () => ({
  publishPaymentCharged: mockPublishPaymentCharged,
  publishPayoutRecorded: mockPublishPayoutRecorded,
}));

import type { CreditSession } from '@balo/db';
import { finalizeBilling } from './finalize-billing.js';

const NOW = new Date('2026-07-20T12:45:00Z');

function session(overrides: Partial<CreditSession> = {}): CreditSession {
  return {
    id: 'session_1',
    companyId: 'company_1',
    expertProfileId: 'expert_1',
    initiatingMemberId: 'user_1',
    connectedMinutes: 45,
    clientRateMinorPerMinute: 333,
    expertAccruedMinor: 11_250,
    overdraftSettledMinor: 0,
    graceEnteredAt: null,
    endedAt: NOW,
    ...overrides,
  } as unknown as CreditSession;
}

describe('finalizeBilling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecord.mockResolvedValue({ record: { id: 'payout_1' }, created: true });
  });

  it('books the payout from the ALREADY-FINALIZED accrual with the session idempotency key', async () => {
    await finalizeBilling(session(), 'live_capture', NOW);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session_1',
        expertProfileId: 'expert_1',
        companyId: 'company_1',
        amountMinor: 11_250, // = session.expertAccruedMinor, never re-derived
        durationMinutes: 45,
        finalizationPath: 'live_capture',
        idempotencyKey: 'payout:session_1',
      })
    );
  });

  it('publishes both notices once and fires the two always-on analytics on first booking', async () => {
    await finalizeBilling(session(), 'live_capture', NOW);
    expect(mockPublishPaymentCharged).toHaveBeenCalledTimes(1);
    expect(mockPublishPayoutRecorded).toHaveBeenCalledTimes(1);
    const events = mockTrackServer.mock.calls.map((c) => c[0]);
    expect(events).toContain('case_billing_finalized');
    expect(events).toContain('expert_payout_recorded');
    // No grace on this session → the grace summary must NOT fire.
    expect(events).not.toContain('case_overdraft_grace_used');
  });

  it('gates ALL side-effects on the created flag (created=false → exactly-once no-op)', async () => {
    mockRecord.mockResolvedValue({ record: { id: 'payout_1' }, created: false });
    await finalizeBilling(session(), 'live_capture', NOW);
    expect(mockPublishPaymentCharged).not.toHaveBeenCalled();
    expect(mockPublishPayoutRecorded).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('fires case_overdraft_grace_used ONLY when the session used grace (Owner Decision O2)', async () => {
    await finalizeBilling(
      session({ graceEnteredAt: new Date('2026-07-20T12:30:00Z'), overdraftSettledMinor: 2500 }),
      'live_capture',
      NOW
    );
    const graceCall = mockTrackServer.mock.calls.find((c) => c[0] === 'case_overdraft_grace_used');
    expect(graceCall).toBeDefined();
    expect(graceCall?.[1]).toMatchObject({
      session_id: 'session_1',
      overdraft_settled_minor: 2500,
      grace_minutes: 15, // 12:30 → 12:45
      distinct_id: 'company_1',
    });
  });

  it('rethrows and skips side-effects if the payout record write fails', async () => {
    mockRecord.mockRejectedValue(new Error('db down'));
    await expect(finalizeBilling(session(), 'live_capture', NOW)).rejects.toThrow('db down');
    expect(mockPublishPaymentCharged).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('does NOT rethrow when a post-commit side-effect fails — the obligation stays booked (D)', async () => {
    // The payout is already committed (created=true); a publish failure must not bubble out and
    // strand the receipt (a retry would see created=false and never re-send).
    mockPublishPaymentCharged.mockRejectedValue(new Error('brevo down'));
    await expect(finalizeBilling(session(), 'live_capture', NOW)).resolves.toBeUndefined();
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });
});
