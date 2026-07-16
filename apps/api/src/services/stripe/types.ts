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
      settlement: SettlementFields;
    }
  | {
      kind: 'mandate_active';
      walletId: string;
      customerId: string;
      paymentMethodId: string;
      mandateRef: string;
    }
  | { kind: 'mandate_failed'; walletId: string }
  | {
      kind: 'charge_failed';
      walletId: string | null;
      paymentIntentId: string;
      code: string | null;
      /** `charge.outcome` (Radar-aware) when retrievable, else `last_payment_error`. */
      outcome: unknown;
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
    };
