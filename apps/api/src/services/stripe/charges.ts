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
 * The webhook metadata a manual purchase stamps. ONE definition, shared by BOTH on-session
 * purchase paths (new card and stored card) so `resolvePaymentIntentSucceeded` cannot tell
 * them apart — a saved-card buy must credit, receipt and reconcile exactly like a new-card buy.
 * Never inline a second copy of this object.
 */
function manualPurchaseMetadata(input: {
  walletId: string;
  initiatingMemberId: string;
  promoCode?: string;
}): Record<string, string> {
  // Stripe metadata values must be strings — include `promoCode` only when present.
  const metadata: Record<string, string> = {
    walletId: input.walletId,
    reason: 'manual_purchase',
    memberId: input.initiatingMemberId,
  };
  if (input.promoCode) metadata.promoCode = input.promoCode;
  return metadata;
}

/**
 * On-session purchase / top-up (BAL-377). Creates a PaymentIntent in the PRESENTMENT
 * currency with `setup_future_usage: 'off_session'` (asks Stripe to save the confirmed
 * payment method for later reuse) and returns the `client_secret` for frontend confirmation.
 *
 * `idempotencyKey` is a caller-supplied STABLE business key — today
 * `purchase:{walletId}:{paymentMethodSource}:{clientRequestId}`, built in
 * `routes/credit/purchase-intent.ts` — passed to Stripe so a retried / double-submitted create
 * returns the SAME PaymentIntent instead of minting a second one; without it, two confirmed PIs
 * would yield two distinct PI-id ledger keys and double-credit the wallet (invariant #2). It must
 * NOT depend on the PI id.
 *
 * ⚠ THE `{paymentMethodSource}` SEGMENT IS LOAD-BEARING, WHICH IS WHY IT IS SPELLED OUT HERE.
 * This function and its sibling `createOnSessionSavedCardCharge` create PaymentIntents with
 * DIFFERENT params (the sibling adds `payment_method` + `confirm: true` + `return_url`), and
 * Stripe 400s ONE idempotency key replayed with different params. BAL-515 moved that separation
 * out of the browser — it used to rest on the web composer re-minting `clientRequestId` on a
 * source switch — and into the server-derived key, so the two paths are structurally unable to
 * collide however the caller behaves.
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
    const pi = await stripe.paymentIntents.create(
      {
        amount: input.presentmentAmountMinor,
        currency: input.presentmentCurrency,
        customer: input.customerId,
        setup_future_usage: 'off_session',
        metadata: manualPurchaseMetadata(input),
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
 * The outcome of an on-session charge against a STORED card. `confirmed` means Stripe accepted
 * the confirmation (the PI status then says whether the browser must still run 3DS);
 * `declined` means the card was refused — a user outcome the route maps to a 402, never a throw.
 */
export type SavedCardChargeResult =
  | {
      outcome: 'confirmed';
      status: Stripe.PaymentIntent.Status;
      clientSecret: string;
      paymentIntentId: string;
    }
  | { outcome: 'declined'; code: string | null; paymentIntentId: string | null };

/** Narrow a Stripe error to its decline code (`decline_code` first — it is the specific one). */
function declineCodeOf(err: unknown): string | null {
  if (err instanceof Stripe.errors.StripeCardError) {
    return err.decline_code ?? err.code ?? null;
  }
  return null;
}

/**
 * On-session purchase against the wallet's ALREADY-STORED payment method (top-up redesign).
 * Sibling of `createOnSessionPurchaseIntent`: identical metadata (one shared builder — the
 * webhook must not be able to tell the two paths apart), identical idempotency-key contract,
 * identical "the webhook credits, never this return value" rule. Differs only in that the
 * PaymentIntent is created WITH the stored payment method and confirmed server-side, because
 * there is no Payment Element for the browser to submit.
 *
 * `off_session: false` is deliberate and load-bearing — the buyer IS present. Passing `true`
 * would claim a consent this path does not have (that consent lives behind
 * `isWalletMandateActive`, captured by an explicit off-session SetupIntent) AND would turn a
 * completable 3DS challenge into a hard decline.
 *
 * `returnUrl` is supplied by the CALLER from trusted server config (`resolveAppUrl`) — NEVER
 * from the browser, which would be an open redirect.
 *
 * A card decline is CAUGHT and returned as `{ outcome: 'declined' }` rather than thrown: it is
 * a user outcome the buyer can act on ("use a different card"), not a system fault. Every other
 * error re-throws.
 */
export async function createOnSessionSavedCardCharge(input: {
  walletId: string;
  customerId: string;
  paymentMethodId: string;
  presentmentCurrency: string;
  presentmentAmountMinor: number;
  initiatingMemberId: string;
  idempotencyKey: string;
  returnUrl: string;
  promoCode?: string;
}): Promise<SavedCardChargeResult> {
  const stripe = getStripeClient();
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: input.presentmentAmountMinor,
        currency: input.presentmentCurrency,
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        off_session: false,
        confirm: true,
        setup_future_usage: 'off_session',
        use_stripe_sdk: true,
        return_url: input.returnUrl,
        metadata: manualPurchaseMetadata(input),
      },
      { idempotencyKey: input.idempotencyKey }
    );

    // Stripe can also report a refusal WITHOUT throwing, by returning the PI parked back in
    // `requires_payment_method` with `last_payment_error`. Same user outcome, same 402.
    if (pi.status === 'requires_payment_method') {
      const code = pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code ?? null;
      log.warn(
        { op: 'createOnSessionSavedCardCharge', walletId: input.walletId, stripeId: pi.id, code },
        'Saved-card charge was refused (PaymentIntent returned requires_payment_method)'
      );
      return { outcome: 'declined', code, paymentIntentId: pi.id };
    }

    const clientSecret = pi.client_secret;
    if (clientSecret === null) {
      throw new Error(`PaymentIntent ${pi.id} was created without a client_secret`);
    }

    log.info(
      {
        op: 'createOnSessionSavedCardCharge',
        walletId: input.walletId,
        stripeId: pi.id,
        status: pi.status,
        amountMinor: input.presentmentAmountMinor,
        currency: input.presentmentCurrency,
      },
      'Confirmed on-session purchase against the stored card (credit arrives via webhook)'
    );

    return { outcome: 'confirmed', status: pi.status, clientSecret, paymentIntentId: pi.id };
  } catch (err: unknown) {
    if (err instanceof Stripe.errors.StripeCardError) {
      const rawPi: unknown = err.payment_intent;
      const pi = (rawPi ?? undefined) as { id?: string } | undefined;
      const code = declineCodeOf(err);
      log.warn(
        {
          op: 'createOnSessionSavedCardCharge',
          walletId: input.walletId,
          code,
          stripeId: pi?.id ?? null,
        },
        'Saved-card charge declined — surfacing to the buyer (no throw)'
      );
      return { outcome: 'declined', code, paymentIntentId: pi?.id ?? null };
    }

    log.error(
      {
        op: 'createOnSessionSavedCardCharge',
        walletId: input.walletId,
        ...stripeErrorLogFields(err),
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to create on-session saved-card PaymentIntent'
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

/** The live status of a settlement PaymentIntent — the reaper's pre-recharge safety check. */
export interface PaymentIntentStatusResult {
  /** Stripe PI status (`succeeded` / `processing` / `canceled` / `requires_payment_method` / …). */
  status: Stripe.PaymentIntent.Status;
  /** A recorded `last_payment_error` that is NOT an SCA prompt — i.e. a hard decline. */
  hardDeclined: boolean;
  /**
   * BAL-515 — the latest charge was refunded IN FULL (`charge.refunded === true`). ⚠ A REFUND DOES
   * NOT MOVE A PI OFF `succeeded`, so `status` alone cannot see it, and a reconcile that reads only
   * the status would credit money that has already gone back to the customer. Reported here rather
   * than inferred at a call site so there is one definition of "the money came back".
   *
   * ⚠⚠ FULL AND PARTIAL ARE REPORTED SEPARATELY, AND CONFLATING THEM DESTROYS MONEY. A single
   * "any money came back" boolean made an A$300 charge with an A$25 refund indistinguishable from
   * a complete reversal, so the reconcile's terminal drain-without-credit arm fired and the A$275
   * the customer is still owed vanished with the marker. `refundedFully` is the ONLY terminal
   * signal; a partial refund is an alarm the caller must escalate, never a write-off. Read
   * `amountRefundedMinor` to tell them apart.
   *
   * `false` when the PI carries no expanded charge (nothing charged yet — nothing to refund).
   */
  refundedFully: boolean;
  /**
   * BAL-515 — `charge.amount_refunded` in the charge's own currency's minor units; `0` when
   * nothing was refunded or there is no charge yet. `> 0` with `refundedFully === false` is a
   * PARTIAL refund: some money came back and the remainder did not.
   */
  amountRefundedMinor: number;
  /**
   * BAL-515 — the amount the PI was CREATED for, in its own currency's minor units. This is the
   * crossing-time figure pinned when the charge was made; a wallet column read at sweep time is
   * not (the company may have changed its reload since). Callers must check `currency` before
   * treating it as AUD.
   */
  amountMinor: number;
  /** The PI's currency, lower-case (`'aud'` for every Balo off-session charge). */
  currency: string;
}

/**
 * Retrieve the current status of a settlement PaymentIntent (BAL-378 FIX 6). READ-ONLY — it
 * NEVER confirms or re-charges. The stuck-settlement reaper calls this BEFORE ever re-invoking
 * the off-session charge: a PI that already `succeeded` (or was `canceled` / hard-declined)
 * must short-circuit rather than risk a second PaymentIntent once Stripe's ~24h idempotency
 * key has expired. Returns `null` when the PI cannot be retrieved (the caller then falls back
 * to its age-bounded decision rather than acting on a phantom status).
 *
 * BAL-515 — `latest_charge` IS EXPANDED FOR THE REFUND READ, and that expansion is load-bearing:
 * a refund leaves the PaymentIntent `succeeded` forever, so without the charge there is no field
 * anywhere on the response that says the money came back. The auto-top-up reconcile has no upper
 * age bound by design, so an operator who answers its alarm by refunding the customer in the
 * Dashboard would otherwise see the very next tick credit the wallet at full face value.
 *
 * ⚠ THE REFUND IS REPORTED AS TWO FIELDS, NOT ONE BOOLEAN. `charge.refunded` is Stripe's own
 * "reversed in full" flag; `charge.amount_refunded` is how much came back. A lossy `refunded ||
 * amount_refunded > 0` collapsed a partial refund into a full one and let the caller write off the
 * un-refunded remainder. Deriving the distinction HERE, once, is what keeps every call site from
 * re-inventing it.
 */
export async function retrievePaymentIntentStatus(
  paymentIntentId: string
): Promise<PaymentIntentStatusResult | null> {
  const stripe = getStripeClient();
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge'],
    });
    const lastError = pi.last_payment_error;
    const hardDeclined =
      lastError !== null && lastError !== undefined && lastError.code !== 'authentication_required';
    // An UN-expanded (string) or absent `latest_charge` means no charge to inspect ⇒ not refunded.
    const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    return {
      status: pi.status,
      hardDeclined,
      // ONLY Stripe's own full-reversal flag is terminal. A charge with `amount_refunded > 0` and
      // `refunded === false` still holds money the customer paid and has not got back.
      refundedFully: charge?.refunded === true,
      amountRefundedMinor: charge?.amount_refunded ?? 0,
      amountMinor: pi.amount,
      currency: pi.currency.toLowerCase(),
    };
  } catch (err: unknown) {
    log.error(
      {
        op: 'retrievePaymentIntentStatus',
        stripeId: paymentIntentId,
        ...stripeErrorLogFields(err),
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to retrieve PaymentIntent status for settlement reconcile'
    );
    return null;
  }
}

/**
 * Stripe creates the charge and its balance transaction in SEPARATE steps, and delivers
 * `payment_intent.succeeded` in between (the default `automatic_async` capture — no
 * `capture_method` is set on either creation path in this file). Observed in dev: a real
 * A$1,000 top-up whose charge had NO `balance_transaction` ~1s after the charge, and a
 * populated one 6 minutes later, on a fully enabled AUD account. That is a RACE, not a
 * fault — so poll briefly instead of 500-ing the first delivery and making the buyer wait
 * a whole Stripe retry interval for credit they have already paid for.
 *
 * Deliberately NOT a fallback to `charge.amount`: `balance_transaction.amount` stays the
 * single source of credited AUD (invariant #8) and its id stays on every money entry, so
 * reconciliation never sees a credit it cannot trace. Exhausting the window still throws →
 * 500 → Stripe's retry remains the durable backstop. This buys latency, never correctness.
 *
 * ~3.75s worst case, paid only on a racing delivery, and only on the `null` arm.
 */
export const BALANCE_TRANSACTION_RETRY_DELAYS_MS = [250, 500, 1000, 2000] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retrieve the settlement fields for a succeeded PaymentIntent (Decision D). Reads the PI
 * to find its `latest_charge`, then the charge with an expanded `balance_transaction`. The
 * credit is `balance_transaction.amount` (GROSS settled AUD — the Stripe fee is Balo's cost
 * absorbed in the 25% markup, never deducted from the client's credit); `exchange_rate` is
 * the fx rate (null for AUD→AUD); `charge.currency`/`charge.amount` are the presentment
 * record. No app-side rate is ever used (invariant #8). Called by the webhook dispatcher.
 */
export async function retrieveSettlement(
  paymentIntentId: string,
  retryDelaysMs: readonly number[] = BALANCE_TRANSACTION_RETRY_DELAYS_MS
): Promise<SettlementFields> {
  const stripe = getStripeClient();

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (chargeId === undefined || chargeId === null) {
    throw new Error(`PaymentIntent ${paymentIntentId} has no latest_charge to settle`);
  }

  let charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  for (const delayMs of retryDelaysMs) {
    if (charge.balance_transaction !== null) break;
    await sleep(delayMs);
    charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  }

  const balanceTransaction = charge.balance_transaction;
  if (typeof balanceTransaction === 'string') {
    // NOT the race: we asked for the expansion and got a bare id back, so re-reading returns
    // the identical response. Fail immediately and with a distinct message — polling here
    // would burn the delay budget on a condition that can never resolve itself.
    throw new TypeError(
      `Charge ${chargeId} returned an un-expanded balance_transaction (expand was not applied)`
    );
  }
  if (balanceTransaction === null) {
    // The buyer's card HAS been charged at this point. Log before throwing: the 500 → Stripe
    // retry is the durable backstop, but nothing else in the system records that a customer's
    // credit is currently outstanding (the webhook writes no marker before this point).
    log.error(
      {
        op: 'retrieveSettlement',
        stripeId: paymentIntentId,
        chargeId,
        attempts: retryDelaysMs.length + 1,
      },
      'Charge still has no balance_transaction after the bounded wait — money charged, credit deferred to Stripe retry'
    );
    throw new Error(
      `Charge ${chargeId} has no balance_transaction yet (${retryDelaysMs.length + 1} attempts)`
    );
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

/**
 * BAL-515 — the outcome of recovering a PaymentIntent whose id was never persisted.
 *
 * `exhaustive` on the `found: false` arm means the window was FULLY enumerated: "not found" is
 * then a conclusion about the whole candidate set rather than about one page. Without it, "not
 * found" is merely "not seen", and the caller must not act on it.
 *
 * ⚠ IT IS A CONDITIONAL CONCLUSION, NOT A FREESTANDING PROOF — see the two premises stated on
 * `findPaymentIntentByIdempotencyKey` below. It is the ONE destructive input the auto-top-up
 * reconcile has (it drains the marker), so read them before trusting it.
 */
export type PaymentIntentLookupResult =
  | { found: true; paymentIntentId: string }
  | { found: false; exhaustive: boolean };

/**
 * BAL-515 — READ-ONLY recovery of the PaymentIntent for a crossing whose id never reached the
 * wallet (the auto-top-up engine threw between `paymentIntents.create` and the marker stamp).
 *
 * ⚠⚠ IT CREATES NOTHING, AND THAT IS THE WHOLE DESIGN. The obvious alternative — re-POSTing
 * `paymentIntents.create` under the same idempotency key — replays the original PaymentIntent
 * WHEN ONE EXISTS and MINTS A REAL CHARGE WHEN ONE DOES NOT. On the exact path this function
 * serves (we do not know whether Stripe ever received the request) that is a coin-flip between
 * a lookup and a fresh charge against a customer's card. So this is a `list`, never a `create`.
 *
 * The scan is bounded by `created[gte] = createdAfter − 60s` (the slack absorbs app↔Stripe clock
 * skew), which is exactly the set of PaymentIntents that could be ours: the marker was armed at
 * `createdAfter` and the charge followed it. Because the WINDOW is bounded rather than the page,
 * a single page with `has_more === false` enumerates the whole candidate set.
 *
 * ⚠ `exhaustive: true` IS A CONCLUSION FROM TWO UNSTATED PREMISES, NOT A STANDALONE PROOF, and it
 * is the ONE DESTRUCTIVE input the auto-top-up reconcile takes: on it the caller drains the marker
 * and abandons a possibly-real charge behind a `log.warn`. Both premises must hold:
 *   1. THE CHARGE CARRIES `wallet.stripeCustomerId` AS ITS CUSTOMER. The `list` filters on
 *      `customer`, so a PaymentIntent created against a different customer id (a wallet whose
 *      customer was re-pointed after the charge) is invisible to a fully-enumerated page.
 *   2. APP↔STRIPE CLOCK SKEW IS ≤ 60s. `created[gte]` is computed from OUR `pendingTopupAt`; a
 *      charge Stripe timestamps more than a minute before it falls outside the window entirely.
 * Neither is checked here, and neither can be checked from inside this function — which is why
 * they are written down instead of implied by the word "proof".
 *
 * Matching is on `metadata.idempotencyKey`, stamped on every off-session charge by
 * `createOffSessionCharge` above.
 *
 * NEVER THROWS. Any Stripe fault answers `{ found: false, exhaustive: false }` — inconclusive,
 * so the caller defers rather than draining a marker on a false negative.
 */
export async function findPaymentIntentByIdempotencyKey(input: {
  customerId: string;
  idempotencyKey: string;
  createdAfter: Date;
}): Promise<PaymentIntentLookupResult> {
  const stripe = getStripeClient();
  const createdGte = Math.floor(input.createdAfter.getTime() / 1000) - 60;
  try {
    const page = await stripe.paymentIntents.list({
      customer: input.customerId,
      created: { gte: createdGte },
      limit: 100,
    });
    for (const pi of page.data) {
      if (pi.metadata?.idempotencyKey === input.idempotencyKey) {
        return { found: true, paymentIntentId: pi.id };
      }
    }
    // `has_more` is the ONLY thing that can turn a miss into a non-proof: the window itself is
    // already bounded, so a fully-listed page means the charge does not exist.
    return { found: false, exhaustive: !page.has_more };
  } catch (err: unknown) {
    log.error(
      {
        op: 'findPaymentIntentByIdempotencyKey',
        customerId: input.customerId,
        ...stripeErrorLogFields(err),
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not list PaymentIntents to recover a lost auto-top-up charge — reporting inconclusive'
    );
    return { found: false, exhaustive: false };
  }
}
