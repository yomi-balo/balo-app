import type Stripe from 'stripe';
import {
  applyLedgerEntry,
  auditEventsRepository,
  creditReceivablesRepository,
  creditSessionsRepository,
  creditWalletsRepository,
  promoRedemptionsRepository,
  db,
  deriveIdempotencyKey,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { toSettleableSession } from '@balo/shared/credit';
import { getStripeClient } from '../../lib/stripe.js';
import { publishSessionSettled, publishSettlementFailure } from '../credit-session/notify.js';
import {
  publishAutoTopupExecuted,
  publishAutoTopupFailed,
  triggerAutoTopupBestEffort,
} from '../credit/auto-topup.js';
import { notificationEvents } from '../../notifications/publisher.js';
import { retrieveSettlement } from './charges.js';
import type { CreditTopupReceipt, PostCommitEffect, StripeEffect } from './types.js';

const log = createLogger('stripe');

/** Active transaction handle — the type `applyLedgerEntry` requires (a `DbExecutor` too). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The three `payment_intent.succeeded` reasons that credit the wallet. */
const CREDIT_REASONS = ['manual_purchase', 'auto_topup', 'overdraft_settlement'] as const;
type CreditReason = (typeof CREDIT_REASONS)[number];

function isCreditReason(value: string | undefined): value is CreditReason {
  return value !== undefined && (CREDIT_REASONS as readonly string[]).includes(value);
}

/** Read `charge.outcome` (Radar-aware) for a failed PI, falling back to `last_payment_error`. */
async function resolveFailureOutcome(pi: Stripe.PaymentIntent): Promise<unknown> {
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (chargeId === undefined || chargeId === null) {
    return pi.last_payment_error ?? null;
  }
  try {
    const stripe = getStripeClient();
    const charge = await stripe.charges.retrieve(chargeId);
    return charge.outcome ?? pi.last_payment_error ?? null;
  } catch (err: unknown) {
    log.warn(
      {
        op: 'resolveFailureOutcome',
        stripeId: chargeId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not retrieve charge outcome for failed payment — using last_payment_error'
    );
    return pi.last_payment_error ?? null;
  }
}

/** The dispute event carries no wallet metadata — recover it from the PaymentIntent. */
async function resolveWalletIdFromPaymentIntent(paymentIntentId: string): Promise<string | null> {
  const stripe = getStripeClient();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  return pi.metadata.walletId ?? null;
}

async function resolvePaymentIntentSucceeded(
  pi: Stripe.PaymentIntent
): Promise<StripeEffect | null> {
  const walletId = pi.metadata.walletId;
  const reason = pi.metadata.reason;
  if (!walletId || !isCreditReason(reason)) {
    // A succeeded PaymentIntent = money already moved, but we can't attribute it to a wallet
    // (no walletId / unknown credit reason). We ack 200 without effect — a retry can't help,
    // the metadata will still be missing — but this is a money-without-credit discrepancy, so
    // it must surface to Sentry/Axiom for a human, NOT be buried in a warn (same posture as an
    // unattributable dispute below). Every PI this module creates always stamps the metadata,
    // so reaching here implies a charge created outside our flow or a contract drift.
    log.error(
      { op: 'resolveStripeEffect', eventType: 'payment_intent.succeeded', stripeId: pi.id },
      'payment_intent.succeeded missing walletId / credit reason metadata — money charged but not credited'
    );
    return null;
  }
  const settlement = await retrieveSettlement(pi.id);
  return {
    kind: 'credit',
    reason,
    walletId,
    memberId: pi.metadata.memberId ?? null,
    sessionId: pi.metadata.sessionId ?? null,
    triggeringEntryId: pi.metadata.triggeringEntryId ?? null,
    // BAL-377 — only a manual_purchase carries an (optional) promo code; auto_topup /
    // overdraft_settlement never stamp it, so they resolve to null by construction.
    promoCode: reason === 'manual_purchase' ? (pi.metadata.promoCode ?? null) : null,
    settlement,
  };
}

async function resolvePaymentIntentFailed(pi: Stripe.PaymentIntent): Promise<StripeEffect> {
  const code = pi.last_payment_error?.code ?? pi.last_payment_error?.decline_code ?? null;
  const outcome = await resolveFailureOutcome(pi);
  return {
    kind: 'charge_failed',
    walletId: pi.metadata.walletId ?? null,
    paymentIntentId: pi.id,
    code,
    outcome,
    // BAL-378: route an ASYNC overdraft-settlement failure to the receivable/dunning path.
    reason: pi.metadata.reason ?? null,
    sessionId: pi.metadata.sessionId ?? null,
    // BAL-379: route an ASYNC auto_topup failure to the failed NOTICE (no receivable). `pi.amount`
    // is the AUD reload minor amount we tried to charge.
    triggeringEntryId: pi.metadata.triggeringEntryId ?? null,
    amountMinor: pi.amount,
  };
}

function resolveSetupIntentSucceeded(si: Stripe.SetupIntent): StripeEffect | null {
  const walletId = si.metadata?.walletId;
  const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id;
  const paymentMethodId =
    typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
  if (!walletId || !customerId || !paymentMethodId) {
    log.warn(
      { op: 'resolveStripeEffect', eventType: 'setup_intent.succeeded', stripeId: si.id },
      'setup_intent.succeeded missing walletId / customer / payment_method — acking without effect'
    );
    return null;
  }
  return { kind: 'mandate_active', walletId, customerId, paymentMethodId, mandateRef: si.id };
}

function resolveSetupIntentFailed(si: Stripe.SetupIntent): StripeEffect | null {
  const walletId = si.metadata?.walletId;
  if (!walletId) {
    log.warn(
      { op: 'resolveStripeEffect', eventType: 'setup_intent.setup_failed', stripeId: si.id },
      'setup_intent.setup_failed missing walletId — acking without effect'
    );
    return null;
  }
  return { kind: 'mandate_failed', walletId };
}

async function resolveDisputeCreated(dispute: Stripe.Dispute): Promise<StripeEffect | null> {
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id;
  const paymentIntentId =
    typeof dispute.payment_intent === 'string'
      ? dispute.payment_intent
      : dispute.payment_intent?.id;
  if (paymentIntentId === undefined || paymentIntentId === null) {
    // A chargeback is real money loss — an unattributable dispute must hit Sentry/Axiom.
    log.error(
      { op: 'resolveStripeEffect', eventType: 'charge.dispute.created', stripeId: dispute.id },
      'charge.dispute.created has no payment_intent — cannot attribute to a wallet'
    );
    return null;
  }
  const walletId = await resolveWalletIdFromPaymentIntent(paymentIntentId);
  if (!walletId) {
    // A chargeback is real money loss — an unattributable dispute must hit Sentry/Axiom.
    log.error(
      { op: 'resolveStripeEffect', eventType: 'charge.dispute.created', stripeId: dispute.id },
      'charge.dispute.created PaymentIntent has no walletId metadata — cannot attribute to a wallet'
    );
    return null;
  }
  return {
    kind: 'dispute',
    walletId,
    disputeId: dispute.id,
    chargeId,
    paymentIntentId,
    amountMinor: dispute.amount,
    currency: dispute.currency,
    reason: dispute.reason,
  };
}

/**
 * Resolve a webhook event into a `StripeEffect` (or null for an unhandled type → the webhook
 * acks 200 with no effect). MAY call Stripe (settlement retrieval, dispute PI lookup) but
 * performs NO DB writes — that keeps the webhook's transaction short (all network I/O happens
 * before it opens).
 */
export async function resolveStripeEffect(event: Stripe.Event): Promise<StripeEffect | null> {
  switch (event.type) {
    case 'payment_intent.succeeded':
      return resolvePaymentIntentSucceeded(event.data.object);
    case 'payment_intent.payment_failed':
      return resolvePaymentIntentFailed(event.data.object);
    case 'setup_intent.succeeded':
      return resolveSetupIntentSucceeded(event.data.object);
    case 'setup_intent.setup_failed':
      return resolveSetupIntentFailed(event.data.object);
    case 'charge.dispute.created':
      return resolveDisputeCreated(event.data.object);
    default:
      return null;
  }
}

/** Derive the ledger idempotency key for a credit effect (reused pure helper — no key logic here). */
function ledgerKeyForCredit(effect: Extract<StripeEffect, { kind: 'credit' }>): string {
  switch (effect.reason) {
    case 'manual_purchase':
      return deriveIdempotencyKey({
        reason: 'manual_purchase',
        paymentIntentId: effect.settlement.stripePaymentIntentId,
      });
    case 'auto_topup': {
      const { triggeringEntryId } = effect;
      if (triggeringEntryId === null) {
        throw new Error('auto_topup credit effect is missing triggeringEntryId metadata');
      }
      return deriveIdempotencyKey({
        reason: 'auto_topup',
        walletId: effect.walletId,
        triggeringEntryId,
      });
    }
    case 'overdraft_settlement': {
      const { sessionId } = effect;
      if (sessionId === null) {
        throw new Error('overdraft_settlement credit effect is missing sessionId metadata');
      }
      return deriveIdempotencyKey({ reason: 'overdraft_settlement', sessionId });
    }
    default: {
      const exhaustive: never = effect.reason;
      throw new Error(`Unhandled credit reason: ${String(exhaustive)}`);
    }
  }
}

/**
 * BAL-378 (§3b.c / §14 Q2) — an `overdraft_settlement` credit succeeded: mark the session
 * `settled` + auto-clear any open receivable (releasing the soft hold), in the SAME webhook
 * txn. The mark + clear are idempotent, so they run on a replay too; but the post-commit
 * receipt publish + analytics fire ONLY on the FIRST (non-deduped) credit application (FIX 9),
 * so a replayed `payment_intent.succeeded` never re-sends the receipt or double-counts. No-op
 * (logs) if the session is gone.
 */
async function markSettlementSettled(
  tx: DbTx,
  sessionId: string,
  paymentIntentId: string,
  deduped: boolean
): Promise<PostCommitEffect[]> {
  const session = await creditSessionsRepository.findById(sessionId);
  if (session === undefined) {
    log.error(
      { op: 'applyStripeEffect', reason: 'overdraft_settlement', sessionId },
      'overdraft_settlement succeeded but the session is missing — cannot mark settled'
    );
    return [];
  }
  await creditSessionsRepository.markSettlementResult(tx, {
    sessionId,
    status: 'settled',
    stripePaymentIntentId: paymentIntentId,
  });
  await creditReceivablesRepository.clear({ sessionId }, tx);
  if (deduped) {
    return [];
  }
  const settleable = toSettleableSession(session);
  return [
    () => publishSessionSettled(settleable, new Date()),
    // BAL-379: an overdraft settlement lands the wallet at ~0 (< threshold) with an active
    // mandate ⇒ a legitimate between-session reload crossing. Best-effort, post-commit — a
    // trigger fault must never make Stripe retry the (already-committed) settlement webhook.
    // Gated on `!deduped` above so a webhook replay never re-evaluates (a replay is inert
    // anyway via the stable key).
    () =>
      triggerAutoTopupBestEffort(session.walletId, {
        op: 'applyStripeEffect',
        reason: 'auto_topup_trigger',
      }),
  ];
}

/**
 * BAL-377 — grant an unadvertised promo BEST-EFFORT in the SAME transaction as the base
 * purchase credit (only on `manual_purchase`). Returns the newly-granted minor units (0 when
 * no code, an idempotent replay, or a re-validation failure). The redeem RE-VALIDATES the
 * code under the `promo_codes` row lock and throws typed errors when it went invalid /
 * expired / exhausted between Apply-time and settlement (rare: concurrent cap-exhaustion or an
 * admin deactivate). Those throws are pure-JS pre-write checks (they fire BEFORE any INSERT/
 * UPDATE), so catching them leaves the surrounding transaction valid — the base purchase still
 * credits and the receipt simply shows no bonus (honest). That "base still credits" guarantee
 * holds ONLY for these pre-write typed throws: a genuine DB-level failure once the promo ledger/
 * redemption INSERT has started would abort the whole transaction and roll back the base credit
 * too. That is acceptable and safe — the webhook is idempotent (event-id gate + idempotency-keyed
 * ledger entries), so Stripe's automatic redelivery re-applies the base credit cleanly on retry;
 * nothing is double-credited and no paid-for credit is permanently lost.
 */
async function grantPromoBestEffort(
  tx: DbTx,
  effect: Extract<StripeEffect, { kind: 'credit' }>,
  companyId: string
): Promise<number> {
  const promoCode = effect.promoCode;
  if (!promoCode) return 0;
  try {
    const result = await promoRedemptionsRepository.redeem(tx, {
      code: promoCode,
      companyId,
      walletId: effect.walletId,
      redeemedByUserId: effect.memberId,
      now: new Date(),
    });
    if (result.outcome === 'redeemed') {
      log.info(
        {
          op: 'applyStripeEffect',
          kind: 'promo_granted',
          walletId: effect.walletId,
          grantMinor: result.grantMinor,
        },
        'Granted promo bonus alongside manual purchase'
      );
      return result.grantMinor;
    }
    // already_redeemed — a replay or the company already used this code; no NEW bonus.
    return 0;
  } catch (err: unknown) {
    log.error(
      {
        op: 'applyStripeEffect',
        kind: 'promo_skipped',
        walletId: effect.walletId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Promo re-validation failed at settlement — skipping bonus (base purchase still credited)'
    );
    return 0;
  }
}

/**
 * BAL-377 — publish the `credit.topup.completed` receipt POST-COMMIT (a persisted marker always
 * implies a committed credit). Relocated from the webhook route so it composes as a
 * `PostCommitEffect` thunk alongside the BAL-378 session publishes (no `fastify` needed — uses
 * the module `log`). Best-effort + idempotent by `correlationId` (`manual_purchase:{piId}` →
 * BullMQ jobId dedup): a publish failure is logged, never thrown (the money is already
 * committed; re-throwing would make Stripe retry the whole webhook for a notification hiccup). A
 * receipt with no purchaser (defensive — a manual_purchase always stamps `memberId`) is skipped.
 */
async function publishTopupReceipt(receipt: CreditTopupReceipt): Promise<void> {
  if (receipt.purchaserUserId === null) {
    log.warn(
      { op: 'publishTopupReceipt', correlationId: receipt.correlationId },
      'credit.topup.completed skipped — manual purchase has no purchaser to notify'
    );
    return;
  }
  try {
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: receipt.correlationId,
      userId: receipt.purchaserUserId,
      companyId: receipt.companyId,
      creditedMinor: receipt.creditedMinor,
      chargedCurrency: receipt.chargedCurrency,
      chargedAmountMinor: receipt.chargedAmountMinor,
      promoGrantedMinor: receipt.promoGrantedMinor,
      balanceAfterMinor: receipt.balanceAfterMinor,
      expiresAt: receipt.expiresAt ?? '',
    });
  } catch (err: unknown) {
    log.error(
      {
        op: 'publishTopupReceipt',
        correlationId: receipt.correlationId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to publish credit.topup.completed receipt (money committed; notification best-effort)'
    );
  }
}

async function applyCredit(
  tx: DbTx,
  effect: Extract<StripeEffect, { kind: 'credit' }>
): Promise<PostCommitEffect[]> {
  const idempotencyKey = ledgerKeyForCredit(effect);
  const base = await applyLedgerEntry(tx, {
    walletId: effect.walletId,
    entryType: 'purchase',
    reason: effect.reason,
    amountMinor: effect.settlement.creditAmountMinor,
    idempotencyKey,
    memberId: effect.memberId,
    sessionId: effect.sessionId,
    chargedCurrency: effect.settlement.chargedCurrency,
    chargedAmountMinor: effect.settlement.chargedAmountMinor,
    fxRate: effect.settlement.fxRate,
    stripePaymentIntentId: effect.settlement.stripePaymentIntentId,
    stripeChargeId: effect.settlement.stripeChargeId,
    stripeBalanceTransactionId: effect.settlement.stripeBalanceTransactionId,
  });
  log.info(
    {
      op: 'applyStripeEffect',
      kind: 'credit',
      reason: effect.reason,
      walletId: effect.walletId,
      stripeId: effect.settlement.stripePaymentIntentId,
      amountMinor: effect.settlement.creditAmountMinor,
      deduped: base.deduped,
    },
    'Applied credit ledger effect'
  );

  // BAL-378: an overdraft settlement credit ALSO marks the session settled + clears the
  // receivable (single webhook source of truth). ledgerKeyForCredit guarantees a non-null
  // sessionId for this reason. A replayed (deduped) credit still idempotently re-marks, but
  // never re-publishes the receipt / re-counts analytics (FIX 9).
  if (effect.reason === 'overdraft_settlement' && effect.sessionId !== null) {
    return markSettlementSettled(
      tx,
      effect.sessionId,
      effect.settlement.stripePaymentIntentId,
      base.deduped
    );
  }

  // BAL-379: a FRESH auto_topup credit surfaces the executed notice + AUTO_TOPUP_FIRED analytics
  // as a post-commit publish. `base.wallet.balanceMinor` is the POST-credit balance, so the
  // pre-reload resting balance that triggered the crossing is `balanceAfter − reload`. Gated on
  // `!base.deduped` ⇒ exactly once per crossing (a replayed webhook returns [], no re-notify /
  // no re-analytics). `ledgerKeyForCredit` guarantees a non-null `triggeringEntryId` here.
  if (effect.reason === 'auto_topup') {
    if (base.deduped || effect.triggeringEntryId === null) {
      return [];
    }
    // BAL-379: the reload landed — CLEAR the single-in-flight marker in the SAME webhook txn so
    // future reloads can fire (at-most-one-in-flight per wallet ⇒ this marker is our own crossing's,
    // so an unconditional clear on the fresh credit is correct).
    await creditWalletsRepository.setPendingTopupAt(effect.walletId, null, tx);
    const reloadedMinor = effect.settlement.creditAmountMinor; // = balance_transaction.amount (AUD face value)
    // `triggerBalanceMinor` reconstructs the PRE-reload resting balance from the POST-credit balance
    // (`balanceAfter − reload`). ANALYTICS-ONLY and approximate: an independent ledger entry landing
    // between fire and this credit (rare, and rarer still with the in-flight marker) would skew it.
    // No state is threaded through Stripe — this is the honest post-commit reconstruction.
    const executed = {
      walletId: effect.walletId,
      companyId: base.wallet.companyId,
      triggeringEntryId: effect.triggeringEntryId,
      reloadedMinor,
      triggerBalanceMinor: base.wallet.balanceMinor - reloadedMinor,
      balanceAfterMinor: base.wallet.balanceMinor,
      expiresAt: base.wallet.expiresAt ? base.wallet.expiresAt.toISOString() : '',
    };
    return [() => publishAutoTopupExecuted(executed)];
  }

  // BAL-377: only a FRESH manual_purchase surfaces a receipt (+ grants any promo) as a
  // post-commit publish. A deduped replay never re-grants or re-publishes; auto_topup has its
  // own lane (above) and overdraft_settlement is handled above.
  if (effect.reason !== 'manual_purchase' || base.deduped) {
    return [];
  }
  const promoGrantedMinor = await grantPromoBestEffort(tx, effect, base.wallet.companyId);
  const receipt: CreditTopupReceipt = {
    correlationId: idempotencyKey, // = manual_purchase:{piId}
    walletId: effect.walletId,
    companyId: base.wallet.companyId,
    purchaserUserId: effect.memberId,
    creditedMinor: effect.settlement.creditAmountMinor,
    chargedCurrency: effect.settlement.chargedCurrency,
    chargedAmountMinor: effect.settlement.chargedAmountMinor,
    promoGrantedMinor,
    // The promo grant (when present) adds to the post-base balance in the same txn.
    balanceAfterMinor: base.wallet.balanceMinor + promoGrantedMinor,
    expiresAt: base.wallet.expiresAt ? base.wallet.expiresAt.toISOString() : null,
  };
  return [() => publishTopupReceipt(receipt)];
}

/**
 * BAL-378 (§3b.b) — an ASYNC `overdraft_settlement` charge failed (after a `processing`
 * accept): mark the session `failed` + open the receivable (soft hold), in the SAME webhook
 * txn. Returns the post-commit dunning publish ONLY when THIS path opened the receivable
 * (`created`) — the sync end-session hard-decline path opens the SAME session receivable, so
 * gating on `created` means exactly one dunning + one analytics fire per failed session,
 * whichever path lands first (FIX 5). No-op (logs) if the session is gone.
 */
async function handleOverdraftChargeFailed(
  tx: DbTx,
  sessionId: string,
  paymentIntentId: string
): Promise<PostCommitEffect[]> {
  const session = await creditSessionsRepository.findById(sessionId);
  if (session === undefined) {
    log.error(
      { op: 'applyStripeEffect', kind: 'charge_failed', reason: 'overdraft_settlement', sessionId },
      'overdraft_settlement failed but the session is missing — cannot open receivable'
    );
    return [];
  }
  await creditSessionsRepository.markSettlementResult(tx, {
    sessionId,
    status: 'failed',
    stripePaymentIntentId: paymentIntentId,
  });
  const amountMinor = session.overdraftSettledMinor ?? 0;
  if (amountMinor <= 0) {
    return [];
  }
  const { created } = await creditReceivablesRepository.open(
    {
      companyId: session.companyId,
      walletId: session.walletId,
      sessionId,
      amountMinor,
      reason: 'settlement_declined',
      stripePaymentIntentId: paymentIntentId,
    },
    tx
  );
  if (!created) {
    return [];
  }
  const settleable = toSettleableSession(session);
  return [
    () =>
      publishSettlementFailure({
        session: settleable,
        reason: 'declined',
        amountMinor,
        attemptEpochMs: Date.now(),
      }),
  ];
}

/** Recognise + log a charge failure, routing an overdraft settlement to receivable/dunning. */
async function applyChargeFailed(
  tx: DbTx,
  effect: Extract<StripeEffect, { kind: 'charge_failed' }>
): Promise<PostCommitEffect[]> {
  const outcome = (effect.outcome ?? null) as { type?: string; reason?: string } | null;
  log.warn(
    {
      op: 'applyStripeEffect',
      kind: 'charge_failed',
      walletId: effect.walletId,
      stripeId: effect.paymentIntentId,
      code: effect.code,
      reason: effect.reason,
      sessionId: effect.sessionId,
      outcomeType: outcome?.type ?? null,
      outcomeReason: outcome?.reason ?? null,
    },
    'Charge failed — recognised'
  );
  // BAL-378: an async overdraft-settlement failure opens the receivable + dunning; other
  // reasons keep the log-only behaviour (their consumer lane owns any follow-up).
  if (effect.reason === 'overdraft_settlement' && effect.sessionId !== null) {
    return handleOverdraftChargeFailed(tx, effect.sessionId, effect.paymentIntentId);
  }
  // BAL-379: an async auto_topup failure routes to the failed NOTICE ONLY — NO receivable, NO
  // account hold (an auto-top-up failure is not money owed; the company keeps spending its
  // existing balance). Notification-only recovery belt: `emitAnalytics: false` so the SYNC engine
  // owns the analytics; the shared `…:failed` correlationId dedups this against the sync notice.
  // The failed PI wrote nothing, so a committed wallet read is correct (balance unchanged since fire).
  if (
    effect.reason === 'auto_topup' &&
    effect.walletId !== null &&
    effect.triggeringEntryId !== null
  ) {
    const walletId = effect.walletId;
    const triggeringEntryId = effect.triggeringEntryId;
    const wallet = await creditWalletsRepository.findById(walletId);
    if (wallet === undefined) {
      return [];
    }
    // BAL-379: the reload definitively failed — CLEAR the single-in-flight marker (in the webhook
    // txn) so a future reload can fire. Idempotent if the sync engine already cleared it.
    await creditWalletsRepository.setPendingTopupAt(walletId, null, tx);
    const failed = {
      walletId,
      companyId: wallet.companyId,
      triggeringEntryId,
      reason: 'declined' as const,
      attemptedMinor: effect.amountMinor ?? wallet.topupReloadMinor,
      triggerBalanceMinor: wallet.balanceMinor,
      failureCode: effect.code ?? undefined,
      emitAnalytics: false,
    };
    return [() => publishAutoTopupFailed(failed)];
  }
  return [];
}

/**
 * Apply a resolved effect inside the caller's webhook transaction. Idempotent — the `credit`
 * path leans on the ledger `idempotency_key` unique (a replay dedups to a no-op); the mandate
 * paths are last-writer-wins column updates; `dispute` appends an audit row. All writes go
 * through the shipped `@balo/db` repos so they commit or roll back with the event marker.
 *
 * Returns the deferred POST-COMMIT effects (notification publishes + analytics) the webhook
 * runs AFTER the txn commits — never inside it. These include the BAL-378 session settled /
 * settlement-failed notices AND the BAL-377 `credit.topup.completed` receipt (a fresh
 * manual_purchase), all modelled uniformly as post-commit thunks.
 */
export async function applyStripeEffect(
  tx: DbTx,
  effect: StripeEffect
): Promise<PostCommitEffect[]> {
  switch (effect.kind) {
    case 'credit':
      return applyCredit(tx, effect);
    case 'mandate_active':
      await creditWalletsRepository.applyMandate(tx, {
        walletId: effect.walletId,
        stripeCustomerId: effect.customerId,
        stripePaymentMethodId: effect.paymentMethodId,
        mandateRef: effect.mandateRef,
        mandateStatus: 'active',
      });
      log.info(
        { op: 'applyStripeEffect', kind: 'mandate_active', walletId: effect.walletId },
        'Mandate activated'
      );
      return [];
    case 'mandate_failed':
      await creditWalletsRepository.applyMandateStatus(tx, effect.walletId, 'failed');
      log.warn(
        { op: 'applyStripeEffect', kind: 'mandate_failed', walletId: effect.walletId },
        'Mandate setup failed'
      );
      return [];
    case 'charge_failed':
      return applyChargeFailed(tx, effect);
    case 'dispute':
      await auditEventsRepository.record(
        {
          actorUserId: null,
          action: 'credit_wallet.dispute_opened',
          entityType: 'credit_wallet',
          entityId: effect.walletId,
          metadata: {
            disputeId: effect.disputeId,
            chargeId: effect.chargeId,
            paymentIntentId: effect.paymentIntentId,
            amountMinor: effect.amountMinor,
            currency: effect.currency,
            reason: effect.reason,
          },
        },
        tx
      );
      log.error(
        {
          op: 'applyStripeEffect',
          kind: 'dispute',
          walletId: effect.walletId,
          disputeId: effect.disputeId,
          chargeId: effect.chargeId,
          amountMinor: effect.amountMinor,
          currency: effect.currency,
          reason: effect.reason,
        },
        'Dispute opened — recognised + audited (no auto-clawback in v1)'
      );
      return [];
    default: {
      const exhaustive: never = effect;
      throw new Error(`Unhandled Stripe effect: ${JSON.stringify(exhaustive)}`);
    }
  }
}
