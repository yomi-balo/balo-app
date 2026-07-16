import type Stripe from 'stripe';
import {
  applyLedgerEntry,
  auditEventsRepository,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { getStripeClient } from '../../lib/stripe.js';
import { retrieveSettlement } from './charges.js';
import type { StripeEffect } from './types.js';

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
    log.warn(
      { op: 'resolveStripeEffect', eventType: 'payment_intent.succeeded', stripeId: pi.id },
      'payment_intent.succeeded missing walletId / credit reason metadata — acking without effect'
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

async function applyCredit(
  tx: DbTx,
  effect: Extract<StripeEffect, { kind: 'credit' }>
): Promise<void> {
  const idempotencyKey = ledgerKeyForCredit(effect);
  await applyLedgerEntry(tx, {
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
    },
    'Applied credit ledger effect'
  );
}

/**
 * Apply a resolved effect inside the caller's webhook transaction. Idempotent — the `credit`
 * path leans on the ledger `idempotency_key` unique (a replay dedups to a no-op); the mandate
 * paths are last-writer-wins column updates; `dispute` appends an audit row. All writes go
 * through the shipped `@balo/db` repos so they commit or roll back with the event marker.
 */
export async function applyStripeEffect(tx: DbTx, effect: StripeEffect): Promise<void> {
  switch (effect.kind) {
    case 'credit':
      await applyCredit(tx, effect);
      return;
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
      return;
    case 'mandate_failed':
      await creditWalletsRepository.applyMandateStatus(tx, effect.walletId, 'failed');
      log.warn(
        { op: 'applyStripeEffect', kind: 'mandate_failed', walletId: effect.walletId },
        'Mandate setup failed'
      );
      return;
    case 'charge_failed': {
      const outcome = (effect.outcome ?? null) as { type?: string; reason?: string } | null;
      log.warn(
        {
          op: 'applyStripeEffect',
          kind: 'charge_failed',
          walletId: effect.walletId,
          stripeId: effect.paymentIntentId,
          code: effect.code,
          outcomeType: outcome?.type ?? null,
          outcomeReason: outcome?.reason ?? null,
        },
        'Charge failed — recognised (consumer lane owns dunning; no ledger effect)'
      );
      return;
    }
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
      return;
    default: {
      const exhaustive: never = effect;
      throw new Error(`Unhandled Stripe effect: ${JSON.stringify(exhaustive)}`);
    }
  }
}
