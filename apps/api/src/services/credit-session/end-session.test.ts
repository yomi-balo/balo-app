import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockEnd,
  mockMarkSettlementResult,
  mockFindWallet,
  mockReceivableOpen,
  mockReceivableClear,
  mockCreateOffSessionCharge,
  mockRetrievePaymentIntentStatus,
  mockApplyOverdraftSettlementFromStripe,
  mockFindLedgerByIdempotencyKey,
  mockDriveSession,
  mockPublishSessionSettled,
  mockPublishSettlementFailure,
  mockAuthorize,
  mockFinalizeBilling,
  mockPark,
  mockTriggerAutoTopup,
  mockWarn,
} = vi.hoisted(() => ({
  mockEnd: vi.fn(),
  mockMarkSettlementResult: vi.fn(),
  mockFindWallet: vi.fn(),
  mockReceivableOpen: vi.fn(),
  mockReceivableClear: vi.fn(),
  mockCreateOffSessionCharge: vi.fn(),
  mockRetrievePaymentIntentStatus: vi.fn(),
  mockApplyOverdraftSettlementFromStripe: vi.fn(),
  mockFindLedgerByIdempotencyKey: vi.fn(),
  mockDriveSession: vi.fn(),
  mockPublishSessionSettled: vi.fn(),
  mockPublishSettlementFailure: vi.fn(),
  mockAuthorize: vi.fn(),
  mockFinalizeBilling: vi.fn(),
  mockPark: vi.fn(),
  mockTriggerAutoTopup: vi.fn(),
  // BAL-525 — exposed (not an anonymous vi.fn() per call) so the O2/O3 warn lines are
  // assertable, matching the sibling `settle-from-presence.test.ts` pattern.
  mockWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    end: mockEnd,
    markSettlementResult: mockMarkSettlementResult,
    parkAwaitingDuration: mockPark,
  },
  creditWalletsRepository: { findById: mockFindWallet },
  creditReceivablesRepository: { open: mockReceivableOpen, clear: mockReceivableClear },
  creditLedgerRepository: { findByIdempotencyKey: mockFindLedgerByIdempotencyKey },
  deriveIdempotencyKey: (input: { sessionId?: string }) =>
    `overdraft_settlement:${input.sessionId}`,
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));
vi.mock('../stripe/index.js', () => ({
  createOffSessionCharge: mockCreateOffSessionCharge,
  retrievePaymentIntentStatus: mockRetrievePaymentIntentStatus,
  applyOverdraftSettlementFromStripe: mockApplyOverdraftSettlementFromStripe,
}));
vi.mock('./meter-driver.js', () => ({ driveSession: mockDriveSession }));
vi.mock('./authorize-session-actor.js', () => ({ authorizeSessionActor: mockAuthorize }));
vi.mock('./finalize-billing.js', () => ({ finalizeBilling: mockFinalizeBilling }));
vi.mock('./notify.js', () => ({
  publishSessionSettled: mockPublishSessionSettled,
  publishSettlementFailure: mockPublishSettlementFailure,
}));
vi.mock('../credit/auto-topup.js', () => ({
  triggerAutoTopupBestEffort: mockTriggerAutoTopup,
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
  // BAL-525 — the settlement instrument pin, matching MANDATE_WALLET below so every EXISTING
  // test (which never mentions the pin) keeps its current charge-the-wallet-pair behaviour.
  settlementStripeCustomerId: 'cus_1',
  settlementStripePaymentMethodId: 'pm_1',
  settlementInstrumentPinnedAt: new Date('2026-07-20T11:00:00Z'),
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

  it('F1 (BAL-466 fix round) — refuses a presence-sourced session (forbidden, no metering or ending)', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      session: { ...SESSION, durationSource: 'presence' },
      role: 'member',
    });
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockPark).not.toHaveBeenCalled();
    expect(mockDriveSession).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('BAL-399: an EXTERNAL session PARKS awaiting duration — no metering / end / settlement', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      session: { ...SESSION, durationSource: 'external' },
      role: 'member',
    });
    mockPark.mockResolvedValue({ ...SESSION, status: 'wrapped', settlementStatus: 'not_required' });
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: {
        settlementStatus: 'not_required',
        overdraftSettledMinor: 0,
        awaitingDuration: true,
      },
    });
    expect(mockPark).toHaveBeenCalledWith('session_1');
    // No wall-clock settlement machinery runs for the external park.
    expect(mockDriveSession).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('BAL-399 durability: an already-ended + FINALIZED session replays finalizeBilling (crash recovery)', async () => {
    // Simulates a crash between the end() commit and the payout booking: end() reports alreadyEnded,
    // the row already carries billingFinalizedAt + finalizationPath. The retry must re-book.
    const finalizedSession = {
      ...SESSION,
      settlementStatus: 'not_required',
      billingFinalizedAt: new Date('2026-07-20T12:45:00Z'),
      finalizationPath: 'confirmed', // PERSISTED path — must win over the live_capture default
    };
    mockEnd.mockResolvedValue(endResult({ alreadyEnded: true, session: finalizedSession }));
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'not_required', overdraftSettledMinor: 0 },
    });
    // Replayed with the PERSISTED path (idempotency lives in finalizeBilling's created guard).
    expect(mockFinalizeBilling).toHaveBeenCalledTimes(1);
    expect(mockFinalizeBilling).toHaveBeenCalledWith(
      finalizedSession,
      'confirmed',
      expect.any(Date)
    );
    // The settlement machinery does NOT re-run on the already-ended branch.
    expect(mockPublishSessionSettled).not.toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('BAL-399 durability: a repeated alreadyEnded replay delegates with stable idempotent inputs (no double-book)', async () => {
    // Two retries land on the alreadyEnded branch: each delegates to finalizeBilling with the SAME
    // (session, persisted path) — the exactly-once dedup is finalizeBilling's payout `created` guard
    // (asserted in finalize-billing.test.ts), so a second booking/notice never happens.
    const finalizedSession = {
      ...SESSION,
      settlementStatus: 'not_required',
      billingFinalizedAt: new Date('2026-07-20T12:45:00Z'),
      finalizationPath: 'confirmed',
    };
    mockEnd.mockResolvedValue(endResult({ alreadyEnded: true, session: finalizedSession }));
    await endSession('session_1', 'user_1');
    await endSession('session_1', 'user_1');
    expect(mockFinalizeBilling).toHaveBeenCalledTimes(2);
    for (const call of mockFinalizeBilling.mock.calls) {
      expect(call[0]).toEqual(finalizedSession);
      expect(call[1]).toBe('confirmed');
    }
  });

  it('BAL-399 durability: a legacy pre-deploy ended session (billingFinalizedAt NULL) is NOT re-finalized', async () => {
    const legacySession = { ...SESSION, settlementStatus: 'settled', billingFinalizedAt: null };
    mockEnd.mockResolvedValue(endResult({ alreadyEnded: true, session: legacySession }));
    await endSession('session_1', 'user_1');
    expect(mockFinalizeBilling).not.toHaveBeenCalled();
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

  it('BAL-379: pokes the between-session auto-top-up trigger on the in-credit path', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 0 }));
    await endSession('session_1', 'user_1');
    expect(mockTriggerAutoTopup).toHaveBeenCalledWith(
      'wallet_1',
      expect.objectContaining({ reason: 'auto_topup_trigger' })
    );
  });

  it('BAL-379: does NOT trigger auto-top-up on the overdraft path (settlement owns that crossing)', async () => {
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 1000, mandateActive: true }));
    mockCreateOffSessionCharge.mockResolvedValue({ status: 'processing', paymentIntentId: 'pi_1' });
    await endSession('session_1', 'user_1');
    expect(mockTriggerAutoTopup).not.toHaveBeenCalled();
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

  it('opens a declined receivable when the FRESH wallet read returns no wallet row at all', async () => {
    // BAL-525 (O3): `settleOverdraft` ALWAYS reads the wallet now — the stale `mandateActive`
    // boolean threaded from the committed terminal transaction no longer gates the read (it used
    // to, via `mandateActive ? await creditWalletsRepository.findById(...) : undefined`, so this
    // case previously never even reached the wallet). `beforeEach` defaults `mockFindWallet` to
    // an ACTIVE-mandate wallet, so this test overrides it to `undefined` — no wallet row at all
    // (e.g. a deleted wallet) — to prove the receivable path still works on that shape. This is
    // the `wallet === undefined` arm of the guard, distinct from the sibling headline test below
    // that pins the "wallet exists but its mandate is not live" arm.
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 700, mandateActive: false }));
    mockFindWallet.mockResolvedValueOnce(undefined);
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

  // ── BAL-525 (ADR-1040 Amendment 5) — the settlement instrument pin + the O3 consent fix ──

  it('BAL-525 (O3, the headline): a stale committed mandateActive=true does NOT authorize a charge once the FRESH wallet has no live mandate', async () => {
    // Simulates the real race this PR closes: `applySavedCardDisplay` swaps the card AND nulls
    // `mandate_status` in one statement, landing in the window between the `end()` commit (which
    // computed `mandateActive: true`) and settlement's own fresh read.
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 900, mandateActive: true }));
    mockFindWallet.mockResolvedValueOnce({
      mandateStatus: null,
      stripeCustomerId: 'cus_new',
      stripePaymentMethodId: 'pm_new',
    });
    const result = await endSession('session_1', 'user_1');
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'failed', overdraftSettledMinor: 900 },
    });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
    expect(mockReceivableOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'settlement_declined', amountMinor: 900 }),
      {}
    );
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'settleOverdraft',
        sessionId: 'session_1',
        walletId: 'wallet_1',
        mandateActiveAtCommit: true,
        mandateActiveNow: false,
      }),
      expect.stringContaining('AT SETTLEMENT TIME')
    );
  });

  it('BAL-525 (O3, the other half): a stale committed mandateActive=false does NOT block a charge once the FRESH wallet HAS a live mandate', async () => {
    // The mirror of the headline test above — proves the fresh read authorizes in BOTH
    // directions, not merely that it can deny. The committed-time observation said no mandate
    // (e.g. the mandate was still `pending` when `end()` ran), but the mandate has since gone
    // live (the SetupIntent confirmed between commit and settlement). `mockFindWallet` keeps its
    // `beforeEach` default (`MANDATE_WALLET`, an active mandate), so nothing needs overriding
    // here — that IS the point: the stale `false` must not carry forward and refuse the charge.
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 900, mandateActive: false }));
    mockCreateOffSessionCharge.mockResolvedValue({ status: 'processing', paymentIntentId: 'pi_1' });
    const result = await endSession('session_1', 'user_1');
    expect(mockCreateOffSessionCharge).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_1', paymentMethodId: 'pm_1' })
    );
    expect(result).toEqual({
      ok: true,
      result: { settlementStatus: 'processing', overdraftSettledMinor: 900 },
    });
  });

  it('BAL-525 (O2): pin matches the live wallet — charges the pinned pair, no disagreement warn', async () => {
    // SESSION's pin (cus_1/pm_1) already matches MANDATE_WALLET — the ordinary, unremarkable case.
    mockEnd.mockResolvedValue(endResult({ overdraftMinor: 1200, mandateActive: true }));
    mockCreateOffSessionCharge.mockResolvedValue({ status: 'processing', paymentIntentId: 'pi_1' });
    await endSession('session_1', 'user_1');
    expect(mockCreateOffSessionCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        idempotencyKey: 'overdraft_settlement:session_1',
      })
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('BAL-525 (O2): pin disagrees with the live wallet — charges the LIVE pair and warns with both ids', async () => {
    mockEnd.mockResolvedValue(
      endResult({
        overdraftMinor: 1200,
        mandateActive: true,
        session: {
          ...SESSION,
          settlementStripeCustomerId: 'cus_old',
          settlementStripePaymentMethodId: 'pm_old',
        },
      })
    );
    mockCreateOffSessionCharge.mockResolvedValue({ status: 'processing', paymentIntentId: 'pi_1' });
    await endSession('session_1', 'user_1');
    // The LIVE pair is charged, never the stale pin (O2 — evidence and preference, not authority).
    expect(mockCreateOffSessionCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        idempotencyKey: 'overdraft_settlement:session_1',
      })
    );
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'settleOverdraft',
        sessionId: 'session_1',
        walletId: 'wallet_1',
        pinnedCustomerId: 'cus_old',
        pinnedPaymentMethodId: 'pm_old',
        livePaymentMethodId: 'pm_1',
      }),
      expect.stringContaining('pin disagrees with the wallet')
    );
  });

  it('BAL-525 (O2): pin absent (legacy row) — charges the wallet pair, no disagreement warn', async () => {
    mockEnd.mockResolvedValue(
      endResult({
        overdraftMinor: 1200,
        mandateActive: true,
        session: {
          ...SESSION,
          settlementStripeCustomerId: null,
          settlementStripePaymentMethodId: null,
          settlementInstrumentPinnedAt: null,
        },
      })
    );
    mockCreateOffSessionCharge.mockResolvedValue({ status: 'processing', paymentIntentId: 'pi_1' });
    await endSession('session_1', 'user_1');
    expect(mockCreateOffSessionCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        idempotencyKey: 'overdraft_settlement:session_1',
      })
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });

  interface PinScenario {
    label: string;
    overrides: Partial<CreditSession>;
  }

  const PIN_SCENARIOS: readonly PinScenario[] = [
    { label: 'pin agrees with the live wallet', overrides: {} },
    {
      label: 'pin disagrees with the live wallet',
      overrides: {
        settlementStripeCustomerId: 'cus_old',
        settlementStripePaymentMethodId: 'pm_old',
      },
    },
    {
      label: 'pin absent (legacy row)',
      overrides: {
        settlementStripeCustomerId: null,
        settlementStripePaymentMethodId: null,
        settlementInstrumentPinnedAt: null,
      },
    },
  ];

  it.each(PIN_SCENARIOS)(
    'BAL-525 (§6.5): the Stripe idempotency key does not vary by instrument — $label',
    async ({ overrides }) => {
      mockCreateOffSessionCharge.mockClear();
      mockEnd.mockResolvedValue(
        endResult({
          overdraftMinor: 1200,
          mandateActive: true,
          session: { ...SESSION, ...overrides },
        })
      );
      mockCreateOffSessionCharge.mockResolvedValue({
        status: 'processing',
        paymentIntentId: 'pi_1',
      });
      await endSession('session_1', 'user_1');
      expect(mockCreateOffSessionCharge).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'overdraft_settlement:session_1' })
      );
    }
  );

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
    // Default = the ORDINARY world: the payment_intent.succeeded webhook already applied the
    // `overdraft_settlement` credit, so reconcile is only re-stating what it did. The repair-arm
    // cases below override this to `undefined` (no credit ⇒ the money is unrecorded).
    mockFindLedgerByIdempotencyKey.mockResolvedValue({ id: 'ledger_1' });
  });

  it('does nothing when the session is no longer processing', async () => {
    await reconcileStuckSettlement(stuck({ settlementStatus: 'settled' }), { now: NOW });
    expect(mockRetrievePaymentIntentStatus).not.toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('marks settled + clears the receivable when the PI succeeded AND the ledger credit exists (no re-charge)', async () => {
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

  // ── The settled-without-credit hazard (the money bug this arm exists to close) ──
  //
  // Reconcile used to mark `settled` + CLEAR the receivable unconditionally, deferring the ledger
  // credit to the `payment_intent.succeeded` webhook. A webhook can permanently fail while still
  // returning HTTP 200 — Stripe then never redelivers — and the row is left reading `settled`
  // (client-visible), dunning stopped, receivable gone, and NO ledger row for money Stripe took.

  it('never marks settled or clears the receivable without an overdraft_settlement ledger entry', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({ status: 'succeeded', hardDeclined: false });
    // The webhook never landed — there is no credit behind the "succeeded" PI.
    mockFindLedgerByIdempotencyKey.mockResolvedValue(undefined);

    await reconcileStuckSettlement(stuck({}), { now: NOW });

    // It looked for the credit under the ONE key all three writers agree on.
    expect(mockFindLedgerByIdempotencyKey).toHaveBeenCalledWith('overdraft_settlement:session_1');
    // Finding none, it applied the credit itself through the webhook pipeline, with the PI it
    // has already proven succeeded. (`applyOverdraftSettlementFromStripe` reads the settlement
    // and does mark + clear INSIDE the ledger-write transaction — asserted in dispatch.test.ts.)
    expect(mockApplyOverdraftSettlementFromStripe).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session_1', walletId: 'wallet_1' }),
      'pi_stuck'
    );
    // ⚠ THE POINT: this module marks NOTHING and clears NOTHING of its own on the repair arm —
    // the mark + clear ride the same transaction as the ledger row, so they can never outrun it.
    expect(mockMarkSettlementResult).not.toHaveBeenCalled();
    expect(mockReceivableClear).not.toHaveBeenCalled();
    // And no second charge: retrieving a settlement is read-only.
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('does NOT re-apply the credit (or re-publish the receipt) when the webhook already landed', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({ status: 'succeeded', hardDeclined: false });
    mockFindLedgerByIdempotencyKey.mockResolvedValue({ id: 'ledger_1' });

    await reconcileStuckSettlement(stuck({}), { now: NOW });

    expect(mockApplyOverdraftSettlementFromStripe).not.toHaveBeenCalled();
    // The mark + clear still run — idempotent re-statements of what the webhook already wrote.
    expect(mockMarkSettlementResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'session_1', status: 'settled' })
    );
    expect(mockReceivableClear).toHaveBeenCalledWith({ sessionId: 'session_1' }, expect.anything());
    // The receipt stayed with the webhook that applied the credit — never re-sent from here.
    expect(mockPublishSessionSettled).not.toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('leaves the debt intact when applying the credit fails (no mark, no clear, error propagates)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({ status: 'succeeded', hardDeclined: false });
    mockFindLedgerByIdempotencyKey.mockResolvedValue(undefined);
    // e.g. `retrieveSettlement` throwing on an un-populated balance_transaction.
    mockApplyOverdraftSettlementFromStripe.mockRejectedValue(new Error('no balance_transaction'));

    await expect(reconcileStuckSettlement(stuck({}), { now: NOW })).rejects.toThrow(
      'no balance_transaction'
    );

    // Nothing was marked, nothing was cleared: the session stays `processing` with its
    // receivable, and pass 4's per-row catch retries on the next tick.
    expect(mockMarkSettlementResult).not.toHaveBeenCalled();
    expect(mockReceivableClear).not.toHaveBeenCalled();
    // Still no second charge on the failure path.
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

  it('BAL-525: threads mandateActiveAtCommit: null into settleOverdraft — there is no in-lock observation this many hours later', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'processing',
      hardDeclined: false,
    });
    // Override the describe's default MANDATE_WALLET so the fresh read has no usable mandate —
    // observable only via the warn log's `mandateActiveAtCommit` field, since
    // `reconcileStuckSettlement` never computed an in-lock boolean of its own to assert on.
    mockFindWallet.mockResolvedValueOnce(undefined);
    await reconcileStuckSettlement(stuck({}), { now: NOW });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'settleOverdraft',
        sessionId: 'session_1',
        mandateActiveAtCommit: null,
        mandateActiveNow: false,
      }),
      expect.stringContaining('AT SETTLEMENT TIME')
    );
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
