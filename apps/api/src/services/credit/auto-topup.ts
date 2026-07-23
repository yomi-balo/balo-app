/**
 * BAL-379 (ADR-1040) — between-session auto-top-up engine + its single-authority publish
 * helpers.
 *
 * When a session settles and the wallet's RESTING balance finalizes below the configured
 * threshold, `evaluateAutoTopup` charges the reload chunk on the company's stored off-session
 * mandate. The `payment_intent.succeeded` webhook (`dispatch.ts`) is the SOLE crediting
 * authority — it writes the `auto_topup` ledger entry keyed
 * `auto_topup:{walletId}:{triggeringEntryId}` and auto-rolls `expires_at`. This engine only
 * DECIDES + CHARGES; it never applies the ledger effect itself.
 *
 * ── Two-phase locking discipline (mirrors BAL-378 `settleOverdraft`) ──
 * Phase 1 (read + guards + pin `triggeringEntryId` + derive the idempotency key + ARM the
 * `pending_topup_at` in-flight marker) runs inside a short txn whose FIRST statement takes the
 * per-wallet advisory lock; the commit releases it. Phase 2 (`createOffSessionCharge`) runs
 * OUTSIDE the lock — the transaction-scoped `pg_advisory_xact_lock` is NEVER held across the slow
 * Stripe HTTP call (holding it would starve the `postgres-js` pool). Correctness does not need the
 * lock across the charge: the lock only has to make two concurrent evaluations agree on
 * `triggeringEntryId` (⇒ the SAME Stripe idempotency key ⇒ Stripe collapses them to one
 * PaymentIntent); the ledger `idempotency_key` unique then guarantees at-most-one CREDIT per
 * crossing even if two PIs somehow land.
 *
 * ── Durable per-wallet single-in-flight marker (`credit_wallets.pending_topup_at`) ──
 * The crossing key alone gives exactly-once PER CROSSING but NOT single-in-flight PER WALLET:
 * session A ends low → fires reload PI₁ (processing, no ledger row yet, balance unchanged); a NEW
 * session B can then open on the mandate (`open()` allows below-threshold starts when the mandate
 * is active), consume ≥1 min (new latest entry `E_B`), end still-low → the crossing guards see no
 * active session / no receivable / balance ≥ 0 and the in-flight PI₁ is INVISIBLE → a SECOND
 * reload PI₂ under a DIFFERENT key → double CHARGE. The marker closes it: Phase 1 ARMS it under the
 * lock on a charge decision; the safe-to-charge guard SKIPS (`topup_in_flight`) while it is set and
 * younger than `TOPUP_IN_FLIGHT_TTL_MS`; the success/fail webhook (or a definite sync failure)
 * CLEARS it. A marker OLDER than the TTL is a lost webhook and a later crossing may re-fire
 * (self-healing).
 *
 * ── Cycle-avoidance ──
 * `createOffSessionCharge` is imported DIRECTLY from `../stripe/charges.js`, NOT the
 * `../stripe/index.js` barrel — the barrel re-exports `dispatch.js`, and `dispatch.js` imports
 * THIS module, so importing the barrel here would create an import cycle.
 *
 * ── >24h Stripe idempotency-key-expiry edge — OUT OF SCOPE (bounded residual) ──
 * Stripe idempotency keys expire ~24h. The only residual: a PI is created, BOTH its success and
 * failure webhooks are NEVER delivered, the `pending_topup_at` TTL elapses (self-heals to allow a
 * re-fire), >24h passes, and the SAME crossing is re-evaluated → a second PI (expired key) → a
 * double CHARGE (still one CREDIT, guaranteed by the ledger key). Bounded: (1) the ledger key makes
 * a double-CREDIT impossible; (2) the marker + TTL prevent a concurrent in-flight re-fire within
 * the window; (3) triggering is INLINE-ONLY, and a subsequent settlement writes NEW ledger entries
 * so a re-fire targets a fresh crossing with its own key; (4) Stripe retries failed webhook
 * deliveries for ~3 days. Fully closing it would need a PI-status recheck home (like BAL-378's), an
 * accepted trade for this ticket.
 */
import {
  acquireWalletLock,
  creditLedgerRepository,
  creditReceivablesRepository,
  creditSessionsRepository,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
} from '@balo/db';
import { isWalletMandateActive } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { TOPUP_IN_FLIGHT_TTL_MS } from '@balo/shared/pricing';
import { trackServer, CREDIT_SERVER_EVENTS } from '@balo/analytics/server';
import { createOffSessionCharge } from '../stripe/charges.js';
import { notificationEvents } from '../../notifications/publisher.js';

const log = createLogger('credit-auto-topup');

/** Why the engine declined to charge (observability + unit-test assertions). */
export type AutoTopupSkipReason =
  | 'mode_off'
  | 'no_mandate'
  | 'above_threshold'
  | 'active_or_held'
  | 'topup_in_flight'
  | 'no_ledger_entry'
  | 'wallet_missing';

/**
 * The discriminated outcome — for observability + unit-test assertions. Callers ignore it
 * (auto-top-up is a best-effort side-effect). `failed` = a DEFINITE non-completion (card decline
 * or off-session SCA) — the failed notice was published and the marker cleared. `indeterminate` =
 * a non-card Stripe error (connection / api / rate_limit / idempotency / invalid_request) where
 * the PI MAY have succeeded — NO notice, NO analytics, marker LEFT for the webhook/TTL.
 */
export type AutoTopupOutcome =
  | { outcome: 'skipped'; reason: AutoTopupSkipReason }
  | { outcome: 'charged'; paymentIntentId: string; triggeringEntryId: string; reloadMinor: number }
  | { outcome: 'failed'; reason: 'requires_action' | 'declined'; triggeringEntryId: string }
  | { outcome: 'indeterminate'; triggeringEntryId: string };

/** Display facts a FRESH (non-deduped) `auto_topup` webhook credit surfaces (from `dispatch.ts`). */
export interface AutoTopupExecutedInput {
  walletId: string;
  companyId: string;
  triggeringEntryId: string;
  reloadedMinor: number; // AUD reload FACE value credited
  triggerBalanceMinor: number; // resting balance that triggered the reload (pre-reload)
  balanceAfterMinor: number; // wallet balance after the reload
  expiresAt: string; // ISO rolled expiry, or '' when unknown
}

/** The failure notice/analytics inputs (from the sync engine OR the async recovery belt). */
export interface AutoTopupFailedInput {
  walletId: string;
  companyId: string;
  triggeringEntryId: string;
  reason: 'declined' | 'requires_action';
  attemptedMinor: number; // AUD reload face value we tried to charge
  triggerBalanceMinor: number; // resting balance at fire time (analytics only)
  failureCode?: string; // Stripe decline code when present (analytics only)
  /** SYNC engine emits analytics (true); the async webhook belt is notification-only (false). */
  emitAnalytics: boolean;
}

/** The params captured out of the Phase-1 locked txn, used to charge in Phase 2. */
interface AutoTopupChargeParams {
  customerId: string;
  paymentMethodId: string;
  companyId: string;
  reloadMinor: number;
  triggerBalanceMinor: number;
  triggeringEntryId: string;
  idempotencyKey: string;
}

type Phase1Result =
  | { kind: 'skip'; reason: AutoTopupSkipReason }
  | { kind: 'charge'; params: AutoTopupChargeParams };

/** The ledger/Stripe idempotency key for a crossing = `auto_topup:{walletId}:{triggeringEntryId}`. */
function crossingKey(walletId: string, triggeringEntryId: string): string {
  return deriveIdempotencyKey({ reason: 'auto_topup', walletId, triggeringEntryId });
}

/**
 * Structural extraction of a Stripe decline code from a thrown error (no Stripe import, mirrors
 * `extractPaymentIntentId` in `end-session.ts`). Prefers `code`, falls back to `decline_code`.
 */
function extractFailureCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }
  const e = error as { code?: unknown; decline_code?: unknown };
  if (typeof e.code === 'string') {
    return e.code;
  }
  if (typeof e.decline_code === 'string') {
    return e.decline_code;
  }
  return undefined;
}

function errorFields(error: unknown): { error: string; stack: string | undefined } {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/**
 * A GENUINE customer card decline — a Stripe `StripeCardError` carries `type === 'card_error'`.
 * The ONLY thrown error that is a definite non-completion we surface (structural, no Stripe import
 * — mirrors `extractFailureCode`). Every OTHER thrown error (connection / api / rate_limit /
 * idempotency-in-progress / invalid_request) is INDETERMINATE: the PI may still have succeeded, so
 * the webhook — not this throw — is authoritative, and we neither notify nor clear the marker.
 */
function isCardDeclineError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { type?: unknown }).type === 'card_error'
  );
}

/**
 * Phase 1 — load the wallet + apply the guard sequence + pin `triggeringEntryId` + derive the
 * idempotency key + ARM the `pending_topup_at` marker, ALL under the per-wallet advisory lock in
 * one short txn. The commit releases the lock. Guard order (exact): mode → valid mandate → below
 * threshold → safe-to-charge (no active session, no open receivable, balance ≥ 0, no fresh
 * in-flight marker) → pin latest entry id → derive key → arm the marker.
 */
async function loadAndDecide(walletId: string): Promise<Phase1Result> {
  return db.transaction(async (tx) => {
    // First statement — serialise against every other wallet writer (consume / settle / expire).
    await acquireWalletLock(tx, walletId);
    const now = new Date();

    const wallet = await creditWalletsRepository.findById(walletId, tx);
    if (wallet === undefined) {
      return { kind: 'skip', reason: 'wallet_missing' };
    }

    // (a) mode.
    if (wallet.lowBalanceMode !== 'auto_topup') {
      return { kind: 'skip', reason: 'mode_off' };
    }

    // (b) valid mandate. The explicit null checks ALSO narrow customer/PM to `string` for the
    //     charge (isWalletMandateActive returns a boolean → no TS narrowing on its own).
    if (
      !isWalletMandateActive(wallet) ||
      wallet.stripeCustomerId === null ||
      wallet.stripePaymentMethodId === null
    ) {
      return { kind: 'skip', reason: 'no_mandate' };
    }

    // (c) resting balance below threshold.
    if (wallet.balanceMinor >= wallet.topupThresholdMinor) {
      return { kind: 'skip', reason: 'above_threshold' };
    }

    // (d) safe-to-charge-between-sessions: never during a live consultation / in-flight
    //     settlement, never on a soft account-hold, never on an unsettled negative balance.
    const activeSession = await creditSessionsRepository.hasActiveSessionForWallet(walletId, tx);
    const openReceivable = await creditReceivablesRepository.hasOpenReceivable(
      wallet.companyId,
      tx
    );
    if (activeSession || openReceivable || wallet.balanceMinor < 0) {
      return { kind: 'skip', reason: 'active_or_held' };
    }

    // (e) single-in-flight: a FRESH `pending_topup_at` marker means a prior reload PI is still in
    //     flight (its success/fail webhook has not cleared it). Skip so a second session can't fire
    //     a concurrent reload. A marker OLDER than the TTL is a lost webhook → treat as stale and
    //     allow the re-fire (self-healing).
    if (
      wallet.pendingTopupAt !== null &&
      now.getTime() - wallet.pendingTopupAt.getTime() < TOPUP_IN_FLIGHT_TTL_MS
    ) {
      return { kind: 'skip', reason: 'topup_in_flight' };
    }

    // Pin the entry that produced the current resting balance ⇒ the crossing's stable key.
    const triggeringEntryId = await creditLedgerRepository.getLatestEntryId(walletId, tx);
    if (triggeringEntryId === undefined) {
      return { kind: 'skip', reason: 'no_ledger_entry' };
    }

    // ARM the in-flight marker BEFORE the txn commits, so any concurrent/subsequent evaluation
    // serialized behind THIS advisory lock sees it set and skips (`topup_in_flight`). This is the
    // single write in the otherwise read-only Phase-1 txn; it commits with the lock release.
    await creditWalletsRepository.setPendingTopupAt(walletId, now, tx);

    return {
      kind: 'charge',
      params: {
        customerId: wallet.stripeCustomerId,
        paymentMethodId: wallet.stripePaymentMethodId,
        companyId: wallet.companyId,
        reloadMinor: wallet.topupReloadMinor,
        triggerBalanceMinor: wallet.balanceMinor,
        triggeringEntryId,
        idempotencyKey: crossingKey(walletId, triggeringEntryId),
      },
    };
  });
}

/**
 * Evaluate + (if eligible) fire a between-session auto-top-up for a wallet. Best-effort: it never
 * throws — a hard decline is caught, published, and swallowed so it can never break the settlement
 * path that triggered it. On `processing`, the credit + executed notice + `auto_topup_fired`
 * analytics land later via the `payment_intent.succeeded` webhook (this engine applies/notifies
 * NOTHING on the success path).
 */
export async function evaluateAutoTopup(walletId: string): Promise<AutoTopupOutcome> {
  const decision = await loadAndDecide(walletId);
  if (decision.kind === 'skip') {
    log.info({ op: 'evaluateAutoTopup', walletId, reason: decision.reason }, 'Auto-top-up skipped');
    return { outcome: 'skipped', reason: decision.reason };
  }

  const { params } = decision;
  try {
    // Phase 2 — charge OUTSIDE the lock. amountMinor is the AUD reload face value.
    const result = await createOffSessionCharge({
      reason: 'auto_topup',
      walletId,
      customerId: params.customerId,
      paymentMethodId: params.paymentMethodId,
      currency: 'aud',
      amountMinor: params.reloadMinor,
      idempotencyKey: params.idempotencyKey,
      triggeringEntryId: params.triggeringEntryId,
    });

    if (result.status === 'processing') {
      log.info(
        {
          op: 'evaluateAutoTopup',
          walletId,
          paymentIntentId: result.paymentIntentId,
          reloadMinor: params.reloadMinor,
          triggeringEntryId: params.triggeringEntryId,
        },
        'Auto-top-up processing — credit + executed notice land via the webhook'
      );
      return {
        outcome: 'charged',
        paymentIntentId: result.paymentIntentId,
        triggeringEntryId: params.triggeringEntryId,
        reloadMinor: params.reloadMinor,
      };
    }

    // requires_action (SCA) — a DEFINITE non-completion: an off-session intent cannot complete SCA,
    // and no async payment_failed webhook is relied upon, so the SYNC path is the sole publisher
    // (emitAnalytics: true). Clear the in-flight marker (no PI will complete) before notifying.
    log.warn(
      {
        op: 'evaluateAutoTopup',
        walletId,
        paymentIntentId: result.paymentIntentId,
        triggeringEntryId: params.triggeringEntryId,
      },
      'Auto-top-up requires authentication (SCA) — notifying billing admins'
    );
    await creditWalletsRepository.setPendingTopupAt(walletId, null);
    await publishAutoTopupFailed({
      walletId,
      companyId: params.companyId,
      triggeringEntryId: params.triggeringEntryId,
      reason: 'requires_action',
      attemptedMinor: params.reloadMinor,
      triggerBalanceMinor: params.triggerBalanceMinor,
      emitAnalytics: true,
    });
    return {
      outcome: 'failed',
      reason: 'requires_action',
      triggeringEntryId: params.triggeringEntryId,
    };
  } catch (error) {
    const failureCode = extractFailureCode(error);

    // A GENUINE card decline is a DEFINITE non-completion: clear the marker (unblock future
    // reloads), publish the failure notice + analytics, then SWALLOW the throw (best-effort —
    // auto-top-up must never break the settlement path). The async payment_intent.payment_failed
    // webhook publishes the SAME notice (jobId-deduped) and also clears the marker.
    if (isCardDeclineError(error)) {
      log.warn(
        {
          op: 'evaluateAutoTopup',
          walletId,
          triggeringEntryId: params.triggeringEntryId,
          failureCode,
          ...errorFields(error),
        },
        'Auto-top-up card declined — notifying billing admins (swallowed)'
      );
      await creditWalletsRepository.setPendingTopupAt(walletId, null);
      await publishAutoTopupFailed({
        walletId,
        companyId: params.companyId,
        triggeringEntryId: params.triggeringEntryId,
        reason: 'declined',
        attemptedMinor: params.reloadMinor,
        triggerBalanceMinor: params.triggerBalanceMinor,
        failureCode,
        emitAnalytics: true,
      });
      return { outcome: 'failed', reason: 'declined', triggeringEntryId: params.triggeringEntryId };
    }

    // INDETERMINATE (connection / api / rate_limit / idempotency-in-progress / invalid_request):
    // the charge MAY have succeeded — the `payment_intent.succeeded` webhook is the sole authority.
    // Do NOT publish a customer-facing failure, do NOT emit analytics, and LEAVE the marker set
    // (the success webhook clears it, or the TTL self-heals a truly-lost webhook). log.error so we
    // investigate (this also catches our-bug cases like invalid_request).
    log.error(
      {
        op: 'evaluateAutoTopup',
        walletId,
        triggeringEntryId: params.triggeringEntryId,
        failureCode,
        ...errorFields(error),
      },
      'Auto-top-up charge indeterminate (non-card error) — webhook is authoritative; marker left set'
    );
    return { outcome: 'indeterminate', triggeringEntryId: params.triggeringEntryId };
  }
}

/**
 * Best-effort trigger for the two inline settlement-completion sites (in-credit end +
 * overdraft-settled webhook). `evaluateAutoTopup` already swallows charge failures internally;
 * this additionally guards a PHASE-1 fault (e.g. a DB read error / lock failure raised OUTSIDE
 * the internal try) so a throw can NEVER roll back — or make Stripe retry — the committed
 * settlement that triggered it. Logs + never rethrows. Extracted so both sites share ONE
 * best-effort wrapper (no duplicated inline `.catch`).
 */
export async function triggerAutoTopupBestEffort(
  walletId: string,
  context: Record<string, unknown>
): Promise<void> {
  try {
    await evaluateAutoTopup(walletId);
  } catch (error) {
    log.error(
      { ...context, walletId, ...errorFields(error) },
      'Auto-top-up trigger failed (best-effort)'
    );
  }
}

/**
 * Publish the `credit.auto_topup.executed` notice + emit `AUTO_TOPUP_FIRED` (money-in truth).
 * Called ONLY from the webhook's FRESH (non-deduped) credit branch ⇒ exactly once per crossing.
 * `correlationId` IS the ledger key ⇒ per-crossing BullMQ jobId dedup. Best-effort: a publish
 * failure is logged, NEVER thrown (the money is committed; re-throwing would make Stripe retry the
 * whole webhook for a notification hiccup — matches `publishTopupReceipt`).
 */
export async function publishAutoTopupExecuted(input: AutoTopupExecutedInput): Promise<void> {
  const correlationId = crossingKey(input.walletId, input.triggeringEntryId);
  try {
    trackServer(CREDIT_SERVER_EVENTS.AUTO_TOPUP_FIRED, {
      amount_minor: input.reloadedMinor,
      trigger_balance_minor: input.triggerBalanceMinor,
      company_id: input.companyId,
      wallet_id: input.walletId,
      distinct_id: input.companyId,
    });
    await notificationEvents.publish('credit.auto_topup.executed', {
      correlationId,
      walletId: input.walletId,
      companyId: input.companyId,
      reloadedMinor: input.reloadedMinor,
      balanceAfterMinor: input.balanceAfterMinor,
      expiresAt: input.expiresAt,
    });
  } catch (error) {
    log.error(
      {
        op: 'publishAutoTopupExecuted',
        correlationId,
        walletId: input.walletId,
        ...errorFields(error),
      },
      'Failed to publish credit.auto_topup.executed (money committed; notification best-effort)'
    );
  }
}

/**
 * Publish the `credit.auto_topup.failed` notice + (SYNC path only) emit `AUTO_TOPUP_FAILED`. The
 * SYNC engine and the ASYNC `payment_intent.payment_failed` belt call this with the SAME
 * `…:failed` correlationId ⇒ the notice delivers exactly once (BullMQ jobId dedup); analytics fire
 * from the sync path only (`emitAnalytics`). NO receivable / NO account hold — an auto-top-up
 * failure is not money owed. Best-effort: a publish failure is logged, never thrown.
 */
export async function publishAutoTopupFailed(input: AutoTopupFailedInput): Promise<void> {
  const correlationId = `${crossingKey(input.walletId, input.triggeringEntryId)}:failed`;
  try {
    if (input.emitAnalytics) {
      trackServer(CREDIT_SERVER_EVENTS.AUTO_TOPUP_FAILED, {
        amount_minor: input.attemptedMinor,
        trigger_balance_minor: input.triggerBalanceMinor,
        failure_reason: input.reason,
        ...(input.failureCode === undefined ? {} : { failure_code: input.failureCode }),
        company_id: input.companyId,
        wallet_id: input.walletId,
        distinct_id: input.companyId,
      });
    }
    await notificationEvents.publish('credit.auto_topup.failed', {
      correlationId,
      walletId: input.walletId,
      companyId: input.companyId,
      reason: input.reason,
      attemptedMinor: input.attemptedMinor,
    });
  } catch (error) {
    log.error(
      {
        op: 'publishAutoTopupFailed',
        correlationId,
        walletId: input.walletId,
        ...errorFields(error),
      },
      'Failed to publish credit.auto_topup.failed (best-effort)'
    );
  }
}
