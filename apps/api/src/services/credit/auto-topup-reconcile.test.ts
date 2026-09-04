import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CreditWallet } from '@balo/db';

const {
  mockFindByIdempotencyKey,
  mockClearPendingTopup,
  mockRecordPendingTopupPaymentIntent,
  mockRetrievePaymentIntentStatus,
  mockFindPaymentIntentByIdempotencyKey,
  mockCreateOffSessionCharge,
  mockApplyAutoTopupFromStripe,
  mockPublishAutoTopupFailed,
  mockLog,
  mockStripeClient,
} = vi.hoisted(() => ({
  mockFindByIdempotencyKey: vi.fn(),
  mockClearPendingTopup: vi.fn(),
  mockRecordPendingTopupPaymentIntent: vi.fn(),
  mockRetrievePaymentIntentStatus: vi.fn(),
  mockFindPaymentIntentByIdempotencyKey: vi.fn(),
  /**
   * ⚠ NOT IMPORTED BY THE MODULE UNDER TEST, AND THAT IS THE ASSERTION. Providing it on the
   * mocked module means that if anyone ever wires a charge into the reconcile, it lands here and
   * the "never charges" test fails instead of minting a real PaymentIntent.
   */
  mockCreateOffSessionCharge: vi.fn(),
  mockApplyAutoTopupFromStripe: vi.fn(),
  mockPublishAutoTopupFailed: vi.fn(),
  /** Stable logger — the aging escalation is a LOG-LEVEL branch, so it is asserted on this. */
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  /** The Stripe CLIENT surface — the assertion of last resort that nothing here ever charges. */
  mockStripeClient: {
    paymentIntents: { create: vi.fn(), confirm: vi.fn(), retrieve: vi.fn(), list: vi.fn() },
    charges: { retrieve: vi.fn() },
  },
}));

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));
vi.mock('@balo/db', () => ({
  creditLedgerRepository: { findByIdempotencyKey: mockFindByIdempotencyKey },
  creditWalletsRepository: {
    clearPendingTopup: mockClearPendingTopup,
    recordPendingTopupPaymentIntent: mockRecordPendingTopupPaymentIntent,
  },
  /**
   * ⚠ REASON-HONOURING, mirroring the real `deriveIdempotencyKey` switch (and `dispatch.test.ts`).
   * A stub that ignored `reason` returned the auto_topup shape for EVERY reason, so the test
   * asserting the reconcile "asks the ledger for EXACTLY the crossing key" pinned the wallet and
   * entry ids but NOT the `auto_topup` discriminator — the SUT could have asked under any reason
   * and stayed green. The real function is pure but lives outside `apps/api`'s `rootDir`, so it
   * cannot be imported here without a TS6059; this switch is the faithful stand-in.
   */
  deriveIdempotencyKey: (input: {
    reason: string;
    walletId?: string;
    triggeringEntryId?: string;
    sessionId?: string;
    paymentIntentId?: string;
  }) => {
    switch (input.reason) {
      case 'auto_topup':
        return `auto_topup:${input.walletId}:${input.triggeringEntryId}`;
      case 'overdraft_settlement':
        return `overdraft_settlement:${input.sessionId}`;
      case 'manual_purchase':
        return `manual_purchase:${input.paymentIntentId}`;
      default:
        return `unhandled_reason:${input.reason}`;
    }
  },
}));
/**
 * ⚠ THE CHARGE SURFACE ITSELF, not just the wrapper. `mockCreateOffSessionCharge` above lives on a
 * module the SUT never imports that symbol from, so asserting it was not called is true against
 * ANY source. This mock is the client every charge in this codebase must ultimately go through —
 * `paymentIntents.create` here catches a charge wired in by any route, including one that bypasses
 * `charges.ts` entirely.
 */
vi.mock('../../lib/stripe.js', () => ({
  getStripeClient: () => mockStripeClient,
  getWebhookSecret: () => 'whsec_test',
}));
vi.mock('../stripe/charges.js', () => ({
  retrievePaymentIntentStatus: mockRetrievePaymentIntentStatus,
  findPaymentIntentByIdempotencyKey: mockFindPaymentIntentByIdempotencyKey,
  createOffSessionCharge: mockCreateOffSessionCharge,
}));
vi.mock('../stripe/dispatch.js', () => ({
  applyAutoTopupFromStripe: mockApplyAutoTopupFromStripe,
}));
vi.mock('./auto-topup.js', () => ({ publishAutoTopupFailed: mockPublishAutoTopupFailed }));

import { TOPUP_RECONCILE_ESCALATE_AFTER_MS } from '@balo/shared/pricing';
import { reconcileStuckAutoTopup } from './auto-topup-reconcile.js';

const PENDING_SINCE = new Date('2026-09-03T10:00:00.000Z');
const CROSSING_KEY = 'auto_topup:wallet_1:led_E';

/** A wallet with a stuck marker whose PaymentIntent id WAS stamped (the fast path). */
function wallet(overrides: Partial<CreditWallet> = {}): CreditWallet {
  return {
    id: 'wallet_1',
    companyId: 'company_1',
    balanceMinor: 500,
    topupReloadMinor: 10_000,
    mandateStatus: 'active',
    stripeCustomerId: 'cus_1',
    pendingTopupAt: PENDING_SINCE,
    pendingTopupTriggeringEntryId: 'led_E',
    pendingTopupPaymentIntentId: 'pi_1',
    ...overrides,
  } as unknown as CreditWallet;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClearPendingTopup.mockResolvedValue(undefined);
  mockRecordPendingTopupPaymentIntent.mockResolvedValue(true);
  mockPublishAutoTopupFailed.mockResolvedValue(undefined);
  mockFindByIdempotencyKey.mockResolvedValue(undefined);
  /**
   * ⚠ THE DEFAULT REPAIR *COMMITS*, and the ledger read reflects that. `repairOrClear` now
   * re-reads the crossing key on the BASE db after the repair transaction resolves (the same
   * commit proof the webhook route carries), so a repair that "wrote" nothing must be expressible.
   * Modelling the write here rather than queueing a `mockResolvedValueOnce` keeps the ledger's
   * before/after states honest — and a phantom commit is then just `mockResolvedValue(undefined)`
   * on this mock, i.e. a transaction that resolved having written nothing.
   */
  mockApplyAutoTopupFromStripe.mockImplementation(async () => {
    mockFindByIdempotencyKey.mockResolvedValue({ id: 'ledger_repaired' });
    // The post-commit thunks now come back UNRUN for the caller to run after its commit proof.
    return [];
  });
  // The full shape `retrievePaymentIntentStatus` now returns. Neither refund field is optional in
  // the fixture: a default of `undefined` would make both refund guards vacuously falsy everywhere.
  mockRetrievePaymentIntentStatus.mockResolvedValue({
    status: 'succeeded',
    hardDeclined: false,
    refundedFully: false,
    amountRefundedMinor: 0,
    amountMinor: 10_000,
    currency: 'aud',
  });
});

describe('reconcileStuckAutoTopup — the guard', () => {
  it('skips not_pending when the marker is not armed', async () => {
    const out = await reconcileStuckAutoTopup(wallet({ pendingTopupAt: null }));
    expect(out).toEqual({ outcome: 'skipped', reason: 'not_pending' });
    expect(mockRetrievePaymentIntentStatus).not.toHaveBeenCalled();
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
  });

  it('skips not_pending when the marker carries no crossing correlation (pre-BAL-515 leftover)', async () => {
    const out = await reconcileStuckAutoTopup(wallet({ pendingTopupTriggeringEntryId: null }));
    expect(out).toEqual({ outcome: 'skipped', reason: 'not_pending' });
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
  });
});

describe('reconcileStuckAutoTopup — THE REPAIR (the acceptance test)', () => {
  it('PI succeeded + NO auto_topup ledger row ⇒ applies the credit via applyAutoTopupFromStripe', async () => {
    mockFindByIdempotencyKey.mockResolvedValue(undefined);

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'repaired', paymentIntentId: 'pi_1' });
    expect(mockApplyAutoTopupFromStripe).toHaveBeenCalledTimes(1);
    expect(mockApplyAutoTopupFromStripe).toHaveBeenCalledWith('wallet_1', 'led_E', 'pi_1');
    expect(mockClearPendingTopup).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      triggeringEntryId: 'led_E',
    });
  });

  it('asks the ledger for EXACTLY the crossing key auto_topup:{walletId}:{triggeringEntryId}', async () => {
    await reconcileStuckAutoTopup(wallet());
    expect(mockFindByIdempotencyKey).toHaveBeenCalledWith(CROSSING_KEY);
  });

  it('does NOT clear the marker when the repair throws (evidence never erased ahead of the money)', async () => {
    mockApplyAutoTopupFromStripe.mockRejectedValue(new Error('balance_transaction not ready'));

    await expect(reconcileStuckAutoTopup(wallet())).rejects.toThrow(/balance_transaction/);

    expect(mockClearPendingTopup).not.toHaveBeenCalled();
  });

  it('repairs a wallet whose mandate is `failed` — a mandate column may never gate RECOVERY', async () => {
    // ⚠ THE F2 ACCOMMODATION, MADE FALSIFIABLE. The module docblock promises that a wrongly-failed
    // mandate (the `resolveSetupIntentFailed` gap: a new card's failed SetupIntent revokes a
    // mandate captured against a DIFFERENT card) can never block recovery of money that has
    // ALREADY been charged. Every other fixture here is `mandateStatus: 'active'`, so a future
    // "safety" guard on that column would ship GREEN and silently re-convert a cosmetic mandate
    // bug into permanent money loss. This is the test that would go red instead.
    const out = await reconcileStuckAutoTopup(wallet({ mandateStatus: 'failed' }));

    expect(out).toEqual({ outcome: 'repaired', paymentIntentId: 'pi_1' });
    expect(mockApplyAutoTopupFromStripe).toHaveBeenCalledWith('wallet_1', 'led_E', 'pi_1');
  });
});

describe('reconcileStuckAutoTopup — the repair COMMIT PROOF', () => {
  it('does NOT clear the marker when the repair transaction resolved WITHOUT writing the ledger row', async () => {
    // ⚠ THE PHANTOM COMMIT, ON THE SECOND CREDITING TRIGGER. A resolved `db.transaction()` is not
    // proof of a commit — that is the incident this ticket closes. Here the repair resolves having
    // written nothing: the in-transaction marker clear rolls back with it, but the clear that
    // follows is a SEPARATE autocommit statement and would land. Credit gone, marker gone,
    // evidence gone, sweep reports `repaired: 1`, crossing permanently unreconcilable. The
    // post-repair read-back on the base `db` is the only thing that stops it.
    mockApplyAutoTopupFromStripe.mockResolvedValue(undefined); // resolves; writes nothing

    await expect(reconcileStuckAutoTopup(wallet())).rejects.toThrow(
      /commit proof failed.*auto_topup:wallet_1:led_E/
    );

    expect(mockClearPendingTopup).not.toHaveBeenCalled();
  });

  it('re-reads the crossing key AFTER the repair, and only then clears (the ORDER is the guarantee)', async () => {
    await reconcileStuckAutoTopup(wallet());

    // Twice under the crossing key: the pre-check that decides to repair, and the commit proof.
    expect(mockFindByIdempotencyKey).toHaveBeenCalledTimes(2);
    expect(mockFindByIdempotencyKey).toHaveBeenNthCalledWith(2, CROSSING_KEY);
    const applyOrder = mockApplyAutoTopupFromStripe.mock.invocationCallOrder[0] ?? 0;
    const proofOrder = mockFindByIdempotencyKey.mock.invocationCallOrder[1] ?? 0;
    const clearOrder = mockClearPendingTopup.mock.invocationCallOrder[0] ?? 0;
    // Proving after the clear would prove nothing — the evidence is already gone by then.
    expect(applyOrder).toBeLessThan(proofOrder);
    expect(proofOrder).toBeLessThan(clearOrder);
  });

  it('does NOT run the post-commit publishes when the commit proof FAILS (nothing notifies on unproven money)', async () => {
    // ⚠ THE ORDERING BUG THIS PINS. `applyAutoTopupFromStripe` used to run its own post-commit
    // effects — the `credit.auto_topup.executed` notice and the `AUTO_TOPUP_FIRED` analytics —
    // inside itself, i.e. BEFORE the read-back below. That is the inverse of
    // `routes/stripe/webhook.ts`, whose proof deliberately precedes its post-commit drain. On a
    // phantom commit the client was told "we added $100" about a credit that does not exist.
    const publish = vi.fn().mockResolvedValue(undefined);
    mockApplyAutoTopupFromStripe.mockResolvedValue([publish]); // resolves; writes NOTHING

    await expect(reconcileStuckAutoTopup(wallet())).rejects.toThrow(/commit proof failed/);

    expect(publish).not.toHaveBeenCalled();
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
  });

  it('runs the post-commit publishes AFTER the proof once the credit is proven committed', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    mockApplyAutoTopupFromStripe.mockImplementation(async () => {
      mockFindByIdempotencyKey.mockResolvedValue({ id: 'ledger_repaired' });
      return [publish];
    });

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'repaired', paymentIntentId: 'pi_1' });
    expect(publish).toHaveBeenCalledTimes(1);
    const proofOrder = mockFindByIdempotencyKey.mock.invocationCallOrder[1] ?? 0;
    const publishOrder = publish.mock.invocationCallOrder[0] ?? 0;
    expect(proofOrder).toBeLessThan(publishOrder);
  });
});

describe('reconcileStuckAutoTopup — a FULLY REFUNDED charge is never credited', () => {
  const refundedStatus = {
    status: 'succeeded',
    hardDeclined: false,
    refundedFully: true,
    amountRefundedMinor: 10_000,
    amountMinor: 10_000,
    currency: 'aud',
  };

  it('clears the marker WITHOUT crediting when the succeeded charge was refunded IN FULL', async () => {
    // ⚠ A REFUND DOES NOT MOVE A PaymentIntent OFF `succeeded`. This pass has no upper age bound,
    // and its own alarm tells the responder to resolve each crossing in the Stripe Dashboard —
    // where refunding the customer is the obvious remedy. Reading only `status`, the very next
    // tick finds no ledger row and credits the wallet at full face value: refund AND credit.
    mockRetrievePaymentIntentStatus.mockResolvedValue(refundedStatus);
    mockFindByIdempotencyKey.mockResolvedValue(undefined);

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'refunded', paymentIntentId: 'pi_1' });
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
    expect(mockClearPendingTopup).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      triggeringEntryId: 'led_E',
    });
  });

  it('still reports already_credited when the credit landed BEFORE the refund (no re-credit either way)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue(refundedStatus);
    mockFindByIdempotencyKey.mockResolvedValue({ id: 'ledger_1' });

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'already_credited', paymentIntentId: 'pi_1' });
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
  });
});

describe('reconcileStuckAutoTopup — a PARTIAL refund never destroys the remainder', () => {
  /** A$300 charged, A$25 refunded — A$275 of credit the customer is genuinely still owed. */
  const partiallyRefundedStatus = {
    status: 'succeeded',
    hardDeclined: false,
    refundedFully: false,
    amountRefundedMinor: 2_500,
    amountMinor: 30_000,
    currency: 'aud',
  };

  it('WRITES NOTHING and does NOT drain the marker — the un-refunded A$275 is not written off', async () => {
    // ⚠⚠ THE HIGH-SEVERITY DEFECT THIS PINS. `retrievePaymentIntentStatus` used to answer one
    // lossy `refunded: true` for a partial refund, so this landed on the TERMINAL arm: the marker
    // was drained, nothing was credited, and A$275 the customer had paid for vanished — silently
    // (a `warn` claiming "the money is already back with the customer") and UNRECOVERABLY, because
    // a drained marker never re-presents to the sweep. Nothing may be cleared here.
    mockRetrievePaymentIntentStatus.mockResolvedValue(partiallyRefundedStatus);
    mockFindByIdempotencyKey.mockResolvedValue(undefined);

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'alarm', reason: 'partial_refund' });
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
    expect(mockPublishAutoTopupFailed).not.toHaveBeenCalled();
  });

  it('escalates with the UN-REFUNDED remainder, and never claims the money is back', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue(partiallyRefundedStatus);
    mockFindByIdempotencyKey.mockResolvedValue(undefined);

    await reconcileStuckAutoTopup(wallet());

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wallet_1',
        paymentIntentId: 'pi_1',
        amountMinor: 30_000,
        amountRefundedMinor: 2_500,
        unrefundedMinor: 27_500,
      }),
      expect.stringContaining('PARTIALLY refunded')
    );
    // The old copy asserted a falsehood about the buyer's money. No arm may say it here.
    const [, message] = mockLog.error.mock.calls[0] ?? [];
    expect(String(message)).not.toMatch(/already back with the customer/i);
  });

  it('takes the ALREADY-CREDITED arm when the credit landed first (a later partial refund is not this pass`s business)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue(partiallyRefundedStatus);
    mockFindByIdempotencyKey.mockResolvedValue({ id: 'ledger_1' });

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'already_credited', paymentIntentId: 'pi_1' });
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
  });
});

describe('reconcileStuckAutoTopup — the other arms', () => {
  it('already_credited: PI succeeded AND the ledger row exists ⇒ clears only, never re-applies', async () => {
    mockFindByIdempotencyKey.mockResolvedValue({ id: 'ledger_1' });

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'already_credited', paymentIntentId: 'pi_1' });
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
    expect(mockClearPendingTopup).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      triggeringEntryId: 'led_E',
    });
  });

  it('failed_closed on a CANCELED PI: clears, then publishes the failed notice with emitAnalytics false', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'canceled',
      hardDeclined: false,
      refundedFully: false,
      amountRefundedMinor: 0,
      amountMinor: 7_500,
      currency: 'aud',
    });

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'failed_closed', paymentIntentId: 'pi_1' });
    expect(mockClearPendingTopup).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      triggeringEntryId: 'led_E',
    });
    expect(mockPublishAutoTopupFailed).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      companyId: 'company_1',
      triggeringEntryId: 'led_E',
      reason: 'declined',
      // ⚠ THE PaymentIntent's amount (7_500), NOT the wallet's CURRENT reload (10_000). This arm
      // fires when the sync notice never went out, so this figure is the only one the buyer sees;
      // a sweep-time read states an amount that may never have been attempted.
      attemptedMinor: 7_500,
      triggerBalanceMinor: 500,
      // The SYNC engine owns auto-top-up analytics — this belt is notification-only, so a
      // reconcile-published notice must never double-count money-in.
      emitAnalytics: false,
    });
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
  });

  it('failed_closed on a HARD-DECLINED PI (status still requires_payment_method)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'requires_payment_method',
      hardDeclined: true,
      refundedFully: false,
      amountRefundedMinor: 0,
      amountMinor: 10_000,
      currency: 'aud',
    });

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'failed_closed', paymentIntentId: 'pi_1' });
    expect(mockPublishAutoTopupFailed).toHaveBeenCalledTimes(1);
  });

  it('defers (writing NOTHING) when the PaymentIntent status cannot be read', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue(null);

    const out = await reconcileStuckAutoTopup(wallet());

    expect(out).toEqual({ outcome: 'deferred', reason: 'pi_unreadable' });
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
    expect(mockPublishAutoTopupFailed).not.toHaveBeenCalled();
  });

  it('defers (writing NOTHING) while the PaymentIntent is genuinely still processing', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'processing',
      hardDeclined: false,
      refundedFully: false,
      amountRefundedMinor: 0,
      amountMinor: 10_000,
      currency: 'aud',
    });

    const out = await reconcileStuckAutoTopup(wallet(), {
      now: new Date(PENDING_SINCE.getTime() + 6 * 60 * 1000),
    });

    expect(out).toEqual({ outcome: 'deferred', reason: 'still_in_flight' });
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
    // Six minutes in, a `processing` PI is still a race — info, not an alarm.
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('(BAL-521 D4/D5) returns its OWN discriminator once past the escalation window, and no longer calls log.error itself', async () => {
    // ⚠ NOTHING MAY DEFER SILENTLY FOREVER — but AS OF BAL-521 §1 the escalation RECORD moved to
    // the SWEEP, which batches ONE `log.error` per tick (see `auto-topup-reconcile-sweep.test.ts`
    // for that half). This test proves only the SERVICE's half: past the window it returns a
    // DISTINCT `still_in_flight_escalated` reason carrying its own identifiers, and it does NOT
    // itself call `log.error` any more — the row still writes nothing and still retries; only the
    // discriminator changed, so the sweep can tell this row apart from an ordinary in-window
    // `still_in_flight` and batch it.
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'processing',
      hardDeclined: false,
      refundedFully: false,
      amountRefundedMinor: 0,
      amountMinor: 10_000,
      currency: 'aud',
    });

    const now = new Date(PENDING_SINCE.getTime() + TOPUP_RECONCILE_ESCALATE_AFTER_MS + 1);
    const out = await reconcileStuckAutoTopup(wallet(), { now });

    expect(out).toEqual({
      outcome: 'deferred',
      reason: 'still_in_flight_escalated',
      paymentIntentId: 'pi_1',
      piStatus: 'processing',
      stuckForMs: now.getTime() - PENDING_SINCE.getTime(),
    });
    expect(mockLog.error).not.toHaveBeenCalled();
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
    expect(mockPublishAutoTopupFailed).not.toHaveBeenCalled();
  });
});

describe('reconcileStuckAutoTopup — statuses an off-session intent can never leave', () => {
  /**
   * ⚠ THE TWO PATHS USED TO DISAGREE ABOUT ONE STATUS. `auto-topup.ts` fail-closes on
   * `requires_action` ("an off-session intent cannot complete SCA"); this file called it "still in
   * flight". And because `retrievePaymentIntentStatus` sets `hardDeclined` FALSE for an
   * `authentication_required` error, such a PI matched NO terminal arm: it wrote nothing, logged,
   * and repeated EVERY MINUTE FOREVER — the marker never clearing, the row never leaving
   * `findStuckPendingTopups`, and the buyer never told their reload had failed.
   */
  it.each([['requires_action'], ['requires_payment_method'], ['requires_confirmation']])(
    'fail-closes a PI parked in %s (a definite non-completion, never a defer)',
    async (status) => {
      mockRetrievePaymentIntentStatus.mockResolvedValue({
        status,
        hardDeclined: false,
        refundedFully: false,
        amountRefundedMinor: 0,
        amountMinor: 8_800,
        currency: 'aud',
      });

      const out = await reconcileStuckAutoTopup(wallet());

      expect(out).toEqual({ outcome: 'failed_closed', paymentIntentId: 'pi_1' });
      expect(mockClearPendingTopup).toHaveBeenCalledWith({
        walletId: 'wallet_1',
        triggeringEntryId: 'led_E',
      });
      expect(mockPublishAutoTopupFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'requires_action',
          // Crossing-time, from the PaymentIntent — not the wallet's current reload (10_000).
          attemptedMinor: 8_800,
          emitAnalytics: false,
        })
      );
    }
  );

  it('still reports `declined` when the PI is BOTH unpaid and hard-declined (arm order matters)', async () => {
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'requires_payment_method',
      hardDeclined: true,
      refundedFully: false,
      amountRefundedMinor: 0,
      amountMinor: 8_800,
      currency: 'aud',
    });

    await reconcileStuckAutoTopup(wallet());

    expect(mockPublishAutoTopupFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'declined' })
    );
  });

  it('falls back to the wallet reload (and warns) when the PaymentIntent is not in AUD', async () => {
    // Reporting non-AUD minor units AS AUD is the bug `retrieveSettlement`'s own currency guard
    // exists for. A stale-but-AUD figure beats a wrong-currency one.
    mockRetrievePaymentIntentStatus.mockResolvedValue({
      status: 'canceled',
      hardDeclined: false,
      refundedFully: false,
      amountRefundedMinor: 0,
      amountMinor: 8_800,
      currency: 'usd',
    });

    await reconcileStuckAutoTopup(wallet());

    expect(mockPublishAutoTopupFailed).toHaveBeenCalledWith(
      expect.objectContaining({ attemptedMinor: 10_000 })
    );
    expect(mockLog.warn).toHaveBeenCalled();
  });
});

describe('reconcileStuckAutoTopup — recovering an unstamped PaymentIntent (READ-ONLY)', () => {
  const unstamped = () => wallet({ pendingTopupPaymentIntentId: null });

  it('scans Stripe by the crossing key, PERSISTS the id, then repairs', async () => {
    mockFindPaymentIntentByIdempotencyKey.mockResolvedValue({
      found: true,
      paymentIntentId: 'pi_recovered',
    });

    const out = await reconcileStuckAutoTopup(unstamped());

    expect(mockFindPaymentIntentByIdempotencyKey).toHaveBeenCalledWith({
      customerId: 'cus_1',
      idempotencyKey: CROSSING_KEY,
      // Bounded to PaymentIntents created at or after the marker was armed.
      createdAfter: PENDING_SINCE,
    });
    expect(mockRecordPendingTopupPaymentIntent).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      triggeringEntryId: 'led_E',
      paymentIntentId: 'pi_recovered',
    });
    expect(out).toEqual({ outcome: 'repaired', paymentIntentId: 'pi_recovered' });
  });

  it('drains the marker when the scan EXHAUSTIVELY proves no charge was ever created', async () => {
    mockFindPaymentIntentByIdempotencyKey.mockResolvedValue({ found: false, exhaustive: true });

    const out = await reconcileStuckAutoTopup(unstamped());

    expect(out).toEqual({ outcome: 'skipped', reason: 'no_charge_found' });
    expect(mockClearPendingTopup).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      triggeringEntryId: 'led_E',
    });
    expect(mockRetrievePaymentIntentStatus).not.toHaveBeenCalled();
    expect(mockApplyAutoTopupFromStripe).not.toHaveBeenCalled();
  });

  it('ALARMS and writes NOTHING on an inconclusive scan (a false negative would let a second charge fire)', async () => {
    mockFindPaymentIntentByIdempotencyKey.mockResolvedValue({ found: false, exhaustive: false });

    const out = await reconcileStuckAutoTopup(unstamped());

    expect(out).toEqual({ outcome: 'alarm', reason: 'payment_intent_unresolvable' });
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
    expect(mockRecordPendingTopupPaymentIntent).not.toHaveBeenCalled();
  });

  it('ALARMS without scanning when the wallet has no Stripe customer to scan', async () => {
    const out = await reconcileStuckAutoTopup(
      wallet({ pendingTopupPaymentIntentId: null, stripeCustomerId: null })
    );

    expect(out).toEqual({ outcome: 'alarm', reason: 'payment_intent_unresolvable' });
    expect(mockFindPaymentIntentByIdempotencyKey).not.toHaveBeenCalled();
    expect(mockClearPendingTopup).not.toHaveBeenCalled();
  });
});

describe('reconcileStuckAutoTopup — it NEVER charges', () => {
  /**
   * ⚠ THE INVARIANT THIS WHOLE MODULE RESTS ON. Unlike `reconcileStuckSettlement`, which CAN
   * re-invoke a session-keyed charge, nothing here may mint a PaymentIntent — which is why the
   * reconcile needs no upper age bound. Drive every arm and assert the charge surface is untouched.
   */
  it('makes no charge-creating call on ANY arm', async () => {
    const status = (over: Record<string, unknown>) => ({
      hardDeclined: false,
      refundedFully: false,
      amountRefundedMinor: 0,
      amountMinor: 10_000,
      currency: 'aud',
      ...over,
    });
    const arms: Array<() => void> = [
      () => mockRetrievePaymentIntentStatus.mockResolvedValue(null),
      () => mockRetrievePaymentIntentStatus.mockResolvedValue(status({ status: 'processing' })),
      () => mockRetrievePaymentIntentStatus.mockResolvedValue(status({ status: 'canceled' })),
      () =>
        mockRetrievePaymentIntentStatus.mockResolvedValue(status({ status: 'requires_action' })),
      () => {
        mockRetrievePaymentIntentStatus.mockResolvedValue(status({ status: 'succeeded' }));
        mockFindByIdempotencyKey.mockResolvedValue({ id: 'ledger_1' });
      },
      () => {
        mockRetrievePaymentIntentStatus.mockResolvedValue(status({ status: 'succeeded' }));
        mockFindByIdempotencyKey.mockResolvedValue(undefined);
      },
      () => {
        mockRetrievePaymentIntentStatus.mockResolvedValue(
          status({ status: 'succeeded', refundedFully: true, amountRefundedMinor: 10_000 })
        );
        mockFindByIdempotencyKey.mockResolvedValue(undefined);
      },
    ];
    for (const arm of arms) {
      arm();
      await reconcileStuckAutoTopup(wallet());
    }
    // …plus the three unstamped arms (recovered / exhausted / inconclusive) and the guard.
    for (const lookup of [
      { found: true, paymentIntentId: 'pi_recovered' },
      { found: false, exhaustive: true },
      { found: false, exhaustive: false },
    ]) {
      mockFindPaymentIntentByIdempotencyKey.mockResolvedValue(lookup);
      await reconcileStuckAutoTopup(wallet({ pendingTopupPaymentIntentId: null }));
    }
    await reconcileStuckAutoTopup(wallet({ pendingTopupAt: null }));

    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
    // ⚠ AND THE CLIENT ITSELF. The line above is true against ANY source (the SUT never imports
    // that symbol from the mocked module), so on its own it proves nothing. These do: every
    // charge in this codebase goes through `paymentIntents.create` / `.confirm` on the client
    // `getStripeClient()` returns, whatever wrapper it is dressed in.
    expect(mockStripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(mockStripeClient.paymentIntents.confirm).not.toHaveBeenCalled();
  });
});
