import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockEnd,
  mockMarkSettlementResult,
  mockFindWallet,
  mockReceivableOpen,
  mockReceivableClear,
  mockCreateOffSessionCharge,
  mockRetrievePaymentIntentStatus,
  mockDriveSession,
  mockPublishSessionSettled,
  mockPublishSettlementFailure,
  mockAuthorize,
} = vi.hoisted(() => ({
  mockEnd: vi.fn(),
  mockMarkSettlementResult: vi.fn(),
  mockFindWallet: vi.fn(),
  mockReceivableOpen: vi.fn(),
  mockReceivableClear: vi.fn(),
  mockCreateOffSessionCharge: vi.fn(),
  mockRetrievePaymentIntentStatus: vi.fn(),
  mockDriveSession: vi.fn(),
  mockPublishSessionSettled: vi.fn(),
  mockPublishSettlementFailure: vi.fn(),
  mockAuthorize: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: { end: mockEnd, markSettlementResult: mockMarkSettlementResult },
  creditWalletsRepository: { findById: mockFindWallet },
  creditReceivablesRepository: { open: mockReceivableOpen, clear: mockReceivableClear },
  deriveIdempotencyKey: (input: { sessionId?: string }) =>
    `overdraft_settlement:${input.sessionId}`,
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));
vi.mock('../stripe/index.js', () => ({
  createOffSessionCharge: mockCreateOffSessionCharge,
  retrievePaymentIntentStatus: mockRetrievePaymentIntentStatus,
}));
vi.mock('./meter-driver.js', () => ({ driveSession: mockDriveSession }));
vi.mock('./authorize-session-actor.js', () => ({ authorizeSessionActor: mockAuthorize }));
vi.mock('./notify.js', () => ({
  publishSessionSettled: mockPublishSessionSettled,
  publishSettlementFailure: mockPublishSettlementFailure,
}));

import type { CreditSession } from '@balo/db';
import { endSession, reconcileStuckSettlement } from './end-session.js';

const SESSION = {
  id: 'session_1',
  companyId: 'company_1',
  walletId: 'wallet_1',
  expertProfileId: 'expert_1',
  initiatingMemberId: 'user_1',
  overdraftSettledMinor: 0,
  expertAccruedMinor: 500,
  settlementStatus: 'not_required',
};

const MANDATE_WALLET = {
  mandateStatus: 'active',
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
};

function endResult(overrides: Record<string, unknown>) {
  return {
    session: SESSION,
    overdraftMinor: 0,
    expertAccruedMinor: 500,
    mandateActive: false,
    alreadyEnded: false,
    ...overrides,
  };
}

describe('endSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, session: SESSION, role: 'member' });
    mockDriveSession.mockResolvedValue({ session: SESSION, transitions: {}, ticksPosted: 0 });
    mockFindWallet.mockResolvedValue(MANDATE_WALLET);
    // Default: this path opened the receivable — the caller duns once (FIX 5).
    mockReceivableOpen.mockResolvedValue({ receivable: { id: 'rcv_1' }, created: true });
  });

  it('authorizes the actor with CONSUME_CREDITS before doing any work', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 0 }));
    await endSession('session_1', 'user_1');
    expect(mockAuthorize).toHaveBeenCalledWith({
      sessionId: 'session_1',
      userId: 'user_1',
      requireCapability: 'consume_credits',
    });
  });

  it('returns the authorization failure (forbidden) without metering or ending', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'forbidden' });
    const result = await endSession('session_1', 'stranger');
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockDriveSession).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('publishes settled (no charge) when there is no overdraft', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 0 }));
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'not_required', overdraftSettledMinor: 0 },
    });
    expect(mockPublishSessionSettled).toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('never returns the raw expertAccruedMinor to the client (fee/PII boundary)', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 0 }));
    const result = await endSession('session_1', 'user_1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.result).not.toHaveProperty('expertAccruedMinor');
  });

  it('drives a final meter before ending', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 0 }));
    await endSession('session_1', 'user_1');
    expect(mockDriveSession).toHaveBeenCalledWith('session_1', expect.any(Date));
  });

  it('charges off-session (processing) on an overdraft with an active mandate', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 1200, mandateActive: true }));
    mockCreateOffSessionCharge.mockResolvedValue({ status: 'processing', paymentIntentId: 'pi_1' });
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'processing', overdraftSettledMinor: 1200 },
    });
    expect(mockCreateOffSessionCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'overdraft_settlement',
        currency: 'aud',
        amountMinor: 1200,
        idempotencyKey: 'overdraft_settlement:session_1',
        sessionId: 'session_1',
      })
    );
    // FIX 6a — stamp the in-flight PI so the reaper can check its real status before re-charging.
    expect(mockMarkSettlementResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 'session_1',
        status: 'processing',
        stripePaymentIntentId: 'pi_1',
      })
    );
    expect(mockReceivableOpen).not.toHaveBeenCalled();
    expect(mockPublishSessionSettled).not.toHaveBeenCalled();
  });

  it('duns only when THIS path opened the receivable (once-only, FIX 5)', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 900, mandateActive: true }));
    mockCreateOffSessionCharge.mockRejectedValue(new Error('card_declined'));
    // The async payment_failed webhook already opened the receivable → this open is a no-op.
    mockReceivableOpen.mockResolvedValue({ receivable: { id: 'rcv_1' }, created: false });
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'failed', overdraftSettledMinor: 900 },
    });
    expect(mockReceivableOpen).toHaveBeenCalled();
    expect(mockPublishSettlementFailure).not.toHaveBeenCalled();
  });

  it('keeps the failed PaymentIntent as the recovery reference on a hard decline (FIX 5)', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 900, mandateActive: true }));
    // A hard-decline StripeCardError carries the failed PI on `.payment_intent`.
    mockCreateOffSessionCharge.mockRejectedValue(
      Object.assign(new Error('card_declined'), { payment_intent: { id: 'pi_hard' } })
    );
    await endSession('session_1', 'user_1');
    expect(mockReceivableOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'settlement_declined', stripePaymentIntentId: 'pi_hard' }),
      {}
    );
  });

  it('opens a recovery receivable + dunning on requires_action (SCA)', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 1200, mandateActive: true }));
    mockCreateOffSessionCharge.mockResolvedValue({
      status: 'requires_action',
      paymentIntentId: 'pi_2',
      clientSecret: 'cs',
    });
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'requires_action', overdraftSettledMinor: 1200 },
    });
    expect(mockMarkSettlementResult).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sessionId: 'session_1',
        status: 'requires_action',
        stripePaymentIntentId: 'pi_2',
      })
    );
    expect(mockReceivableOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'settlement_requires_action', amountMinor: 1200 }),
      {}
    );
    expect(mockPublishSettlementFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'requires_action', amountMinor: 1200 })
    );
  });

  it('opens a declined receivable + dunning when the charge throws (hard decline)', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 900, mandateActive: true }));
    mockCreateOffSessionCharge.mockRejectedValue(new Error('card_declined'));
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'failed', overdraftSettledMinor: 900 },
    });
    expect(mockMarkSettlementResult).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sessionId: 'session_1', status: 'failed' })
    );
    expect(mockReceivableOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'settlement_declined', amountMinor: 900 }),
      {}
    );
    expect(mockPublishSettlementFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'declined', amountMinor: 900 })
    );
  });

  it('opens a declined receivable when an overdraft has no usable mandate', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 700, mandateActive: false }));
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'failed', overdraftSettledMinor: 700 },
    });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
    expect(mockReceivableOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'settlement_declined', amountMinor: 700 }),
      {}
    );
  });

  it('is a no-op re-end for an already-ended session', async () => {
    mockEnd.mockResolvedValue(
      endResult({
        alreadyEnded: true,
        session: { ...SESSION, settlementStatus: 'settled', overdraftSettledMinor: 1200 },
      })
    );
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'settled', overdraftSettledMinor: 1200 },
    });
    expect(mockPublishSessionSettled).not.toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });
});

describe('reconcileStuckSettlement', () => {
  const NOW = new Date('2026-07-16T12:00:00.000Z');
  const RECENT = new Date('2026-07-16T11:00:00.000Z'); // 1h old — well within the 20h window
  const OLD = new Date('2026-07-15T00:00:00.000Z'); // >20h old — past the safe window

  function stuck(overrides: Partial<CreditSession>): CreditSession {
    return {
      ...SESSION,
      settlementStatus: 'processing',
      overdraftSettledMinor: 1200,
      endedAt: RECENT,
      stripePaymentIntentId: 'pi_stuck',
      ...overrides,
    } as unknown as CreditSession;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWallet.mockResolvedValue(MANDATE_WALLET);
    mockReceivableOpen.mockResolvedValue({ receivable: { id: 'rcv_1' }, created: true });
  });

  it('does nothing when the session is no longer processing', async () => {
    await reconcileStuckSettlement(stuck({ settlementStatus: 'settled' }), { now: NOW });
    expect(mockRetrievePaymentIntentStatus).not.toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('marks settled + clears the receivable when the stored PI already succeeded (no re-charge)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({ status: 'succeeded', hardDeclined: false });
    await reconcileStuckSettlement(stuck({}), { now: NOW });
    expect(mockRetrievePaymentIntentStatus).toHaveBeenCalledWith('pi_stuck');
    expect(mockMarkSettlementResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 'session_1',
        status: 'settled',
        stripePaymentIntentId: 'pi_stuck',
      })
    );
    expect(mockReceivableClear).toHaveBeenCalledWith({ sessionId: 'session_1' }, expect.anything());
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('opens a receivable + duns when the stored PI is hard-declined (no re-charge)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'requires_payment_method',
      hardDeclined: true,
    });
    await reconcileStuckSettlement(stuck({}), { now: NOW });
    expect(mockReceivableOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'settlement_declined', stripePaymentIntentId: 'pi_stuck' }),
      expect.anything()
    );
    expect(mockPublishSettlementFailure).toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('opens a receivable + duns when the stored PI is canceled (no re-charge)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({ status: 'canceled', hardDeclined: false });
    await reconcileStuckSettlement(stuck({}), { now: NOW });
    expect(mockReceivableOpen).toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('re-charges when the PI is still in flight and within the reconcile window', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'processing',
      hardDeclined: false,
    });
    mockCreateOffSessionCharge.mockResolvedValue({
      status: 'processing',
      paymentIntentId: 'pi_stuck',
    });
    await reconcileStuckSettlement(stuck({}), { now: NOW });
    expect(mockCreateOffSessionCharge).toHaveBeenCalled();
  });

  it('does NOT re-charge past the safe reconcile window (avoids a duplicate PaymentIntent)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'processing',
      hardDeclined: false,
    });
    await reconcileStuckSettlement(stuck({ endedAt: OLD }), { now: NOW });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('re-charges the legacy no-stamped-PI case within the window', async () => {
    mockCreateOffSessionCharge.mockResolvedValue({
      status: 'processing',
      paymentIntentId: 'pi_new',
    });
    await reconcileStuckSettlement(stuck({ stripePaymentIntentId: null }), { now: NOW });
    expect(mockRetrievePaymentIntentStatus).not.toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).toHaveBeenCalled();
  });
});
