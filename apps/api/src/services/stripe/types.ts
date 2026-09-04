/**
 * Shared types for the Stripe provider layer (BAL-382). Pure type module — no runtime,
 * no Stripe import — so it is safe to import from anywhere in the provider surface.
 */

/**
 * The settlement figures captured from a succeeded PaymentIntent's charge + expanded
 * `balance_transaction` (Decision D — Stripe converts at settlement; we capture, never
 * compute an app-side rate). All amounts are integer minor units.
 */
export interface SettlementFields {
  /** AUD minor units credited = `balance_transaction.amount` (GROSS settled AUD, not net). */
  creditAmountMinor: number;
  /** `charge.currency` — the presentment currency, lowercase (e.g. 'usd', 'aud'). */
  chargedCurrency: string;
  /** `charge.amount` — presentment minor units (what the card was billed). */
  chargedAmountMinor: number;
  /** `balance_transaction.exchange_rate` as a string; null when presentment is AUD (AUD→AUD). */
  fxRate: string | null;
  stripePaymentIntentId: string;
  stripeChargeId: string;
  stripeBalanceTransactionId: string;
}

/**
 * Display-only facts of a saved card, read from a Stripe PaymentMethod (top-up redesign).
 * NEVER credentials — brand, last4 and expiry are exactly what a checkout prints back at the
 * cardholder, and none of them can charge anything. Structurally identical to `@balo/db`'s
 * `CardDisplayInput`, which is what the repository writes take; this is the apps/api-side
 * spelling so the provider layer stays free of a db import.
 */
export interface CardDisplayFields {
  cardBrand: string; // pm.card.brand, e.g. 'visa'
  cardLast4: string; // pm.card.last4
  cardExpMonth: number; // pm.card.exp_month
  cardExpYear: number; // pm.card.exp_year
}

/**
 * The card a buyer just paid with, as carried on a `manual_purchase` credit effect so the
 * webhook can persist it for DISPLAY on their next visit (`applySavedCardDisplay`).
 *
 * ⚠ Carrying the payment-method id here does NOT grant an off-session charge right. The
 * applier writes it WITHOUT touching `mandate_status`, and every off-session consumer gates on
 * `isWalletMandateActive` (which requires `mandate_status === 'active'`). The weaker
 * `isWalletCardReusableOnSession` is what this enables: reuse while the buyer is present.
 */
export type CardOnFileFields = {
  customerId: string;
  paymentMethodId: string;
} & CardDisplayFields;

/**
 * Off-session charge input (BAL-382). A discriminated union on `reason` so the correlation
 * ids the webhook's ledger-key derivation REQUIRES are enforced at COMPILE time — an
 * `overdraft_settlement` must carry `sessionId` (+ member attribution) and an `auto_topup`
 * must carry `triggeringEntryId`. This closes the "card charged, wallet never credited" gap
 * (a missing id would otherwise throw inside the webhook txn → 500 → infinite Stripe retry).
 */
export type OffSessionChargeInput = {
  walletId: string;
  customerId: string;
  paymentMethodId: string;
  currency: string;
  amountMinor: number;
  /** Stable state-derived key (from `deriveIdempotencyKey`) — Stripe key AND webhook metadata. */
  idempotencyKey: string;
} & (
  | {
      reason: 'overdraft_settlement';
      memberId: string;
      sessionId: string;
      triggeringEntryId?: null;
    }
  | { reason: 'auto_topup'; memberId?: null; triggeringEntryId: string; sessionId?: null }
);

/**
 * The outcome of an off-session charge attempt. `processing` ⇒ the credit arrives via the
 * `payment_intent.succeeded` webhook (never applied from the create() return — invariant).
 * `requires_action` ⇒ SCA is required; the consumer lane re-prompts the client on-session
 * with the returned `clientSecret` (this layer only detects + surfaces, never re-confirms).
 */
export type OffSessionChargeResult =
  | { status: 'processing'; paymentIntentId: string }
  | { status: 'requires_action'; paymentIntentId: string; clientSecret: string };

/**
 * A deferred side-effect an `applyStripeEffect` branch returns for the webhook to run AFTER the
 * transaction commits (BAL-378). Notification publishes (BullMQ) + `trackServer` (PostHog) are
 * external I/O that must never run inside — or be undone by a rollback of — the webhook txn.
 */
export type PostCommitEffect = () => Promise<void>;

/**
 * A resolved, side-effect-free description of what a Stripe webhook event should DO to the
 * ledger/wallet. `resolveStripeEffect` builds it (may call Stripe, no DB writes);
 * `applyStripeEffect` applies it inside the webhook transaction (DB writes, no Stripe calls).
 */
export type StripeEffect =
  | {
      kind: 'credit';
      reason: 'manual_purchase' | 'auto_topup' | 'overdraft_settlement';
      walletId: string;
      memberId: string | null;
      sessionId: string | null;
      triggeringEntryId: string | null;
      /**
       * BAL-377 — an unadvertised promo code carried in the manual_purchase PI metadata,
       * granted BEST-EFFORT alongside the base purchase credit (only on `manual_purchase`;
       * always `null` for `auto_topup` / `overdraft_settlement`).
       */
      promoCode: string | null;
      /**
       * The card the buyer just used, for DISPLAY on their next visit. NON-NULL ONLY for
       * `reason === 'manual_purchase'` — by construction in the resolver, the same shape of
       * guarantee `promoCode` carries. Also `null` whenever the PaymentIntent named no
       * customer / payment method, or the Stripe read failed (fail-soft: a missing
       * "Visa •••• 4242" is cosmetic, a failed credit is a money bug).
       */
      cardOnFile: CardOnFileFields | null;
      settlement: SettlementFields;
    }
  | {
      kind: 'mandate_active';
      walletId: string;
      customerId: string;
      paymentMethodId: string;
      mandateRef: string;
      /**
       * Display facts of the just-confirmed card, or `null` when Stripe could not be read.
       * `null` leaves the wallet's existing display columns untouched rather than blanking a
       * card the buyer can still see.
       */
      card: CardDisplayFields | null;
    }
  | { kind: 'mandate_failed'; walletId: string }
  | {
      kind: 'charge_failed';
      walletId: string | null;
      paymentIntentId: string;
      code: string | null;
      /** `charge.outcome` (Radar-aware) when retrievable, else `last_payment_error`. */
      outcome: unknown;
      /**
       * BAL-378: PI metadata `reason` + `sessionId` — an ASYNC `overdraft_settlement` failure
       * (after a `processing` accept) routes to the receivable/dunning path; `manual_purchase`
       * keeps the log-only behaviour.
       */
      reason: string | null;
      sessionId: string | null;
      /**
       * BAL-379: PI metadata `triggeringEntryId` + the PI `amount` — an ASYNC `auto_topup`
       * failure routes to the failed NOTICE (notification-only, NO receivable). `triggeringEntryId`
       * is `null` for non-auto_topup reasons; `amountMinor` is always the PI `amount`, read only on
       * the `auto_topup` arm.
       */
      triggeringEntryId: string | null;
      amountMinor: number | null;
    }
  | {
      kind: 'dispute';
      walletId: string;
      disputeId: string;
      chargeId: string;
      paymentIntentId: string;
      amountMinor: number;
      currency: string;
      reason: string;
    }
  | {
      /**
       * BAL-515 — the card network reissued the card behind a stored payment method
       * (`payment_method.automatically_updated`). The payment-method id is UNCHANGED by
       * definition; only the printed digits moved. Carries NO payment-method id and NO mandate
       * fields, because there is no consent event here to record — see `refreshSavedCardDisplay`.
       */
      kind: 'card_display_refreshed';
      walletId: string;
      card: CardDisplayFields;
    }
  | {
      /**
       * BAL-515 — the payment method was detached at Stripe (`payment_method.detached`). Nothing
       * is chargeable against it any more, so the applier clears the display columns, the
       * payment-method id AND the mandate columns (fail-closed).
       */
      kind: 'saved_card_detached';
      walletId: string;
      paymentMethodId: string;
      /**
       * BAL-521 (D7) — the Stripe event id, carried for the notification correlationId and the
       * logs ONLY. ⚠ IT MUST NEVER REACH THE AUDIT ROW: `clearSavedCardAndReconcileMode`'s
       * `metadata` is `{ source, modeReconciled, lowBalanceMode }` and nothing else — the Stripe
       * event id already lives in the webhook receipt, and the audit trail correlates by wallet +
       * time, not by Stripe id.
       */
      stripeEventId: string;
      /**
       * BAL-521 (D9) — brand + last4 lifted straight off the EVENT's PaymentMethod, exactly as
       * the sibling `resolvePaymentMethodUpdated` already does above. `null` for a non-card
       * payment method (the mandate still clears; only the display label degrades).
       * ⚠ DELIBERATELY NOT `CardDisplayFields`: this arm WRITES no display columns (it NULLS
       * them), so carrying a write-shaped object here would invite someone to feed it to
       * `applySavedCardDisplay` / `refreshSavedCardDisplay`. A narrower type makes that
       * impossible.
       */
      cardLabel: { cardBrand: string; cardLast4: string } | null;
    };

/**
 * BAL-377 — the display facts a FRESH manual_purchase credit surfaces so the webhook can
 * publish the `credit.topup.completed` receipt POST-COMMIT. All amounts are integer AUD
 * minor units captured at settlement/commit time (never re-hydrated later). There is NO fee
 * field (BAL-357): a top-up buys AUD at FACE VALUE; the Balo fee lives in the per-minute
 * consume rate, so `creditedMinor` is the GROSS settled AUD (`balance_transaction.amount`),
 * never a fee-net figure. Surfaced ONLY on a non-deduped manual_purchase credit — a replay
 * (deduped) yields `null` so the receipt is never re-published from the money path (the
 * BullMQ jobId dedup on `manual_purchase:{piId}` is the belt to this suspenders).
 */
export interface CreditTopupReceipt {
  correlationId: string; // = manual_purchase:{piId}
  walletId: string;
  companyId: string;
  purchaserUserId: string | null; // the initiating member (recipient 'self')
  creditedMinor: number; // GROSS settled AUD credited
  chargedCurrency: string; // presentment currency (lowercase)
  chargedAmountMinor: number; // presentment minor units
  promoGrantedMinor: number; // 0 when no promo was redeemed at settlement
  balanceAfterMinor: number; // wallet balance after the credit (+ any promo grant)
  expiresAt: string | null; // ISO rolled expiry (rolling-expiry reassurance)
}
