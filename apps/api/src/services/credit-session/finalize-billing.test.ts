import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockRecord,
  mockTrackServer,
  mockPublishPaymentCharged,
  mockPublishPayoutRecorded,
  mockPublishSessionMissedCall,
} = vi.hoisted(() => ({
  mockRecord: vi.fn(),
  mockTrackServer: vi.fn(),
  mockPublishPaymentCharged: vi.fn(),
  mockPublishPayoutRecorded: vi.fn(),
  mockPublishSessionMissedCall: vi.fn(),
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
  publishSessionMissedCall: mockPublishSessionMissedCall,
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
    // BAL-412 — NULL by default (a `live_capture` session); overridden per-test for the
    // presence-settled scenarios below.
    actualMinutes: null,
    settlementShape: null,
    // BAL-412 (F14) — the SNAPSHOTTED floor predicate, NULL on a `live_capture` row. The
    // analytics `floored:` key reads THIS column and never re-derives it from
    // `connectedMinutes > actualMinutes` (see the Q1-clamp case below for why).
    floorApplied: null,
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

describe('finalizeBilling — BAL-412 (ADR-1044 §7, D8) zero-settlement shapes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecord.mockResolvedValue({ record: { id: 'payout_1' }, created: true });
    // `clearAllMocks()` clears CALLS, not IMPLEMENTATIONS — an earlier describe's
    // `mockRejectedValue` would otherwise bleed into these tests. Restore healthy defaults.
    mockPublishPaymentCharged.mockResolvedValue(undefined);
    mockPublishPayoutRecorded.mockResolvedValue(undefined);
    mockPublishSessionMissedCall.mockResolvedValue(undefined);
  });

  it('missed_call: books the (zero) payout obligation, suppresses payment/payout notices, publishes the missed-call notice instead', async () => {
    await finalizeBilling(
      session({
        connectedMinutes: 0,
        expertAccruedMinor: 0,
        actualMinutes: 0,
        settlementShape: 'missed_call',
        finalizationPath: 'presence',
      }),
      'presence',
      NOW
    );
    // Obligation is STILL booked (zero-valued is a real fact, not a skip).
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 0, durationMinutes: 0 })
    );
    expect(mockPublishPaymentCharged).not.toHaveBeenCalled();
    expect(mockPublishPayoutRecorded).not.toHaveBeenCalled();
    expect(mockPublishSessionMissedCall).toHaveBeenCalledTimes(1);
  });

  it('abandoned_wait: books the obligation, publishes NOTHING (D2 — not a reliability judgement)', async () => {
    await finalizeBilling(
      session({
        connectedMinutes: 0,
        expertAccruedMinor: 0,
        actualMinutes: 8,
        settlementShape: 'abandoned_wait',
        finalizationPath: 'presence',
      }),
      'presence',
      NOW
    );
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockPublishPaymentCharged).not.toHaveBeenCalled();
    expect(mockPublishPayoutRecorded).not.toHaveBeenCalled();
    expect(mockPublishSessionMissedCall).not.toHaveBeenCalled();
  });

  it('both zero shapes still fire the always-on analytics (a zero settlement is a real data point)', async () => {
    await finalizeBilling(
      session({
        connectedMinutes: 0,
        expertAccruedMinor: 0,
        actualMinutes: 0,
        floorApplied: false,
        settlementShape: 'missed_call',
        finalizationPath: 'presence',
      }),
      'presence',
      NOW
    );
    const call = mockTrackServer.mock.calls.find((c) => c[0] === 'case_billing_finalized');
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      actual_min: 0,
      floored: false, // the core's answer for a zero shape: ruleMinutes(0) is not > actual(0)
      settlement_outcome: 'missed_call',
    });
  });

  it('held (non-zero presence shape) publishes the ordinary notices, not the missed-call one', async () => {
    await finalizeBilling(
      session({
        connectedMinutes: 15,
        expertAccruedMinor: 1_200,
        actualMinutes: 6,
        floorApplied: true,
        settlementShape: 'held',
        finalizationPath: 'presence',
      }),
      'presence',
      NOW
    );
    expect(mockPublishPaymentCharged).toHaveBeenCalledTimes(1);
    expect(mockPublishPayoutRecorded).toHaveBeenCalledTimes(1);
    expect(mockPublishSessionMissedCall).not.toHaveBeenCalled();
    const call = mockTrackServer.mock.calls.find((c) => c[0] === 'case_billing_finalized');
    expect(call?.[1]).toMatchObject({
      actual_min: 6,
      floored: true, // the core's answer: ruleMinutes(15) > actualMinutes(6) — the floor bound
      settlement_outcome: 'held',
    });
  });

  // ⚠⚠ F14 — THE REGRESSION THIS COLUMN EXISTS FOR. The old code derived `floored` as
  // `connectedMinutes > actualMinutes`, which is TRUE here (10 > 6) even though NO floor was
  // involved: `ruleMinutes` was 6, and it was the Q1 NO-REFUND CLAMP that raised the billed
  // figure to the 10 minutes already drawn. Reporting that as a floor application inflates
  // D7's "how often does the minimum bind" metric with every overcharge — the two events are
  // opposite in meaning and must never be counted together.
  it('Q1 no-refund clamp is NOT reported as a floor application (floored reads the snapshot, never billed>actual)', async () => {
    await finalizeBilling(
      session({
        connectedMinutes: 10, // clamped UP to minutes already drawn
        expertAccruedMinor: 800,
        actualMinutes: 6, // what presence actually justified
        floorApplied: false, // the core: ruleMinutes(6) is NOT > actualMinutes(6)
        settlementShape: 'held',
        finalizationPath: 'presence',
      }),
      'presence',
      NOW
    );
    const call = mockTrackServer.mock.calls.find((c) => c[0] === 'case_billing_finalized');
    expect(call?.[1]).toMatchObject({ actual_min: 6, duration_min: 10, floored: false });
  });

  it('a live_capture session (actualMinutes NULL) omits the three optional analytics keys', async () => {
    await finalizeBilling(session(), 'live_capture', NOW);
    const call = mockTrackServer.mock.calls.find((c) => c[0] === 'case_billing_finalized');
    expect(call?.[1]).not.toHaveProperty('actual_min');
    expect(call?.[1]).not.toHaveProperty('floored');
    expect(call?.[1]).not.toHaveProperty('settlement_outcome');
  });
});
