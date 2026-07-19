import Stripe from 'stripe';
import { createLogger } from '@balo/shared/logging';
import { getStripeClient } from '../../lib/stripe.js';
import { StripeSettlementError } from './errors.js';
import type { OffSessionChargeInput, OffSessionChargeResult, SettlementFields } from './types.js';

const log = createLogger('stripe');

/** Safe-to-log Stripe error fields — code + request id, never card data or secrets. */
function stripeErrorLogFields(err: unknown): { code: string | null; requestId: string | null } {
  if (err instanceof Stripe.errors.StripeError) {
    return { code: err.code ?? null, requestId: err.requestId ?? null };
  }
  return { code: null, requestId: null };
}

/**
 * On-session purchase / top-up (BAL-377). Creates a PaymentIntent in the PRESENTMENT
 * currency with `setup_future_usage: 'off_session'` (asks Stripe to save the confirmed
 * payment method for later reuse) and returns the `client_secret` for frontend confirmation.
 *
 * `idempotencyKey` is a caller-supplied STABLE business key (e.g. `purchase:{walletId}:
 * {clientRequestId}`) passed to Stripe so a retried / double-submitted create returns the
 * SAME PaymentIntent instead of minting a second one — without it, two confirmed PIs would
 * yield two distinct PI-id ledger keys and double-credit the wallet (invariant #2). It must
 * NOT depend on the PI id.
 *
 * Stamps webhook metadata `{ walletId, reason: 'manual_purchase', memberId, promoCode? }`; the
 * credit is applied on `payment_intent.succeeded`, keyed on the resulting PI id
 * (`manual_purchase:{piId}`), so the lane never applies the ledger effect itself.
 * `initiatingMemberId` is REQUIRED — a manual purchase is member-attributed (Decision C),
 * threaded into the ledger's audit row. `promoCode` (BAL-377) is OPTIONAL: when present it
 * rides in metadata so the webhook grants the unadvertised promo bonus BEST-EFFORT in the
 * SAME transaction as the base purchase credit — the promo is granted ONLY on successful
 * payment, never at Apply-time (no free credit to users who never pay).
 *
 * NOTE: this path only saves the payment method with Stripe; it does NOT populate the
 * wallet's mandate columns (that happens on `setup_intent.succeeded` → `applyMandate`). An
 * off-session charge therefore requires a prior SetupIntent-captured mandate on the wallet.
 * Never sets `payment_method_types` (dynamic payment methods — best practice).
 */
export async function createOnSessionPurchaseIntent(input: {
  walletId: string;
  customerId: string;
  presentmentCurrency: string;
  presentmentAmountMinor: number;
  initiatingMemberId: string;
  idempotencyKey: string;
  /** BAL-377 — an unadvertised promo code to grant on successful payment (webhook). */
  promoCode?: string;
}): Promise<{ clientSecret: string; paymentIntentId: string }> {
  const stripe = getStripeClient();
  try {
    // Stripe metadata values must be strings — include `promoCode` only when present.
    const metadata: Record<string, string> = {
      walletId: input.walletId,
      reason: 'manual_purchase',
      memberId: input.initiatingMemberId,
    };
    if (input.promoCode) metadata.promoCode = input.promoCode;

    const pi = await stripe.paymentIntents.create(
      {
        amount: input.presentmentAmountMinor,
        currency: input.presentmentCurrency,
        customer: input.customerId,
        setup_future_usage: 'off_session',
        metadata,
      },
      { idempotencyKey: input.idempotencyKey }
    );

    const clientSecret = pi.client_secret;
    if (clientSecret === null) {
      throw new Error(`PaymentIntent ${pi.id} was created without a client_secret`);
    }

    log.info(
      {
        op: 'createOnSessionPurchaseIntent',
        walletId: input.walletId,
        stripeId: pi.id,
        amountMinor: input.presentmentAmountMinor,
        currency: input.presentmentCurrency,
      },
      'Created on-session purchase PaymentIntent'
    );

    return { clientSecret, paymentIntentId: pi.id };
  } catch (err: unknown) {
    log.error(
      {
        op: 'createOnSessionPurchaseIntent',
        walletId: input.walletId,
        ...stripeErrorLogFields(err),
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to create on-session purchase PaymentIntent'
    );
    throw err;
  }
}

/**
 * Off-session charge against the stored mandate (overdraft settlement BAL-378 / auto-top-up
 * BAL-379). Input is a discriminated union on `reason` (`OffSessionChargeInput`) so the
 * correlation id the webhook needs to derive the ledger key is guaranteed at compile time.
 * Passes the state-derived `idempotencyKey` as BOTH the Stripe idempotency key (so a BullMQ
 * retry returns the original PI, never a second charge) AND webhook metadata. Does NOT apply
 * the ledger effect — the `payment_intent.succeeded` webhook is authoritative.
 *
 * On `authentication_required` (SCA) it returns `{ status: 'requires_action', … }` WITHOUT
 * throwing, so the consumer lane can re-prompt the client on-session. Hard declines and any
 * other error re-throw for the lane's dunning path. Never sets `payment_method_types`.
 */
export async function createOffSessionCharge(
  input: OffSessionChargeInput
): Promise<OffSessionChargeResult> {
  const stripe = getStripeClient();

  // Stripe metadata values must be strings — include only the present ones.
  const metadata: Record<string, string> = {
    walletId: input.walletId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.memberId) metadata.memberId = input.memberId;
  if (input.sessionId) metadata.sessionId = input.sessionId;
  if (input.triggeringEntryId) metadata.triggeringEntryId = input.triggeringEntryId;

  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency,
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        off_session: true,
        confirm: true,
        metadata,
      },
      { idempotencyKey: input.idempotencyKey }
    );

    log.info(
      {
        op: 'createOffSessionCharge',
        walletId: input.walletId,
        reason: input.reason,
        stripeId: pi.id,
        amountMinor: input.amountMinor,
        currency: input.currency,
      },
      'Created off-session charge (processing — credit arrives via webhook)'
    );

    return { status: 'processing', paymentIntentId: pi.id };
  } catch (err: unknown) {
    if (err instanceof Stripe.errors.StripeCardError && err.code === 'authentication_required') {
      const rawPi: unknown = err.payment_intent;
      const pi = (rawPi ?? undefined) as { id?: string; client_secret?: string | null } | undefined;
      const paymentIntentId = pi?.id ?? '';
      const clientSecret = pi?.client_secret ?? '';

      log.warn(
        {
          op: 'createOffSessionCharge',
          walletId: input.walletId,
          reason: input.reason,
          code: err.code,
          stripeId: paymentIntentId,
        },
        'Off-session charge requires authentication (SCA) — surfacing to consumer lane'
      );

      return { status: 'requires_action', paymentIntentId, clientSecret };
    }

    log.error(
      {
        op: 'createOffSessionCharge',
        walletId: input.walletId,
        reason: input.reason,
        ...stripeErrorLogFields(err),
        error: err instanceof Error ? err.message : String(err),
      },
      'Off-session charge failed (hard decline / error) — re-throwing for dunning'
    );
    throw err;
  }
}

/**
 * Retrieve the settlement fields for a succeeded PaymentIntent (Decision D). Reads the PI
 * to find its `latest_charge`, then the charge with an expanded `balance_transaction`. The
 * credit is `balance_transaction.amount` (GROSS settled AUD — the Stripe fee is Balo's cost
 * absorbed in the 25% markup, never deducted from the client's credit); `exchange_rate` is
 * the fx rate (null for AUD→AUD); `charge.currency`/`charge.amount` are the presentment
 * record. No app-side rate is ever used (invariant #8). Called by the webhook dispatcher.
 */
export async function retrieveSettlement(paymentIntentId: string): Promise<SettlementFields> {
  const stripe = getStripeClient();

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (chargeId === undefined || chargeId === null) {
    throw new Error(`PaymentIntent ${paymentIntentId} has no latest_charge to settle`);
  }

  const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  const balanceTransaction = charge.balance_transaction;
  if (balanceTransaction === null || typeof balanceTransaction === 'string') {
    throw new Error(`Charge ${chargeId} is missing an expanded balance_transaction`);
  }

  // Money-integrity guard: the wallet is AUD-only and `creditAmountMinor` is credited AS AUD
  // minor units. A non-AUD settlement (multi-settlement-currency account / misconfig) must
  // fail loudly (→ webhook 500 → Stripe retry) instead of silently crediting foreign minor
  // units as AUD.
  if (balanceTransaction.currency.toLowerCase() !== 'aud') {
    throw new StripeSettlementError(
      `Settlement currency ${balanceTransaction.currency} is not AUD for PaymentIntent ${paymentIntentId}`
    );
  }

  return {
    creditAmountMinor: balanceTransaction.amount,
    chargedCurrency: charge.currency,
    chargedAmountMinor: charge.amount,
    fxRate:
      balanceTransaction.exchange_rate === null ? null : String(balanceTransaction.exchange_rate),
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: charge.id,
    stripeBalanceTransactionId: balanceTransaction.id,
  };
}
