/**
 * Typed Stripe provider errors (BAL-382). Mirrors `services/airwallex/errors.ts` — a
 * small, named error so a misconfiguration surfaces loudly (a throw, never a silent
 * `!` non-null assertion on a missing env var).
 */
export class StripeConfigError extends Error {
  constructor(detail: string) {
    super(`Stripe configuration error: ${detail}`);
    this.name = 'StripeConfigError';
  }
}

/**
 * Thrown when a settlement does not settle in AUD (BAL-382). The wallet is AUD-only and
 * `creditAmountMinor` is credited AS AUD minor units, so a non-AUD `balance_transaction`
 * would silently corrupt a money balance. Throwing surfaces the misconfiguration loudly
 * (the webhook 500s → Stripe retries) instead of mis-crediting foreign minor units.
 */
export class StripeSettlementError extends Error {
  constructor(detail: string) {
    super(`Stripe settlement error: ${detail}`);
    this.name = 'StripeSettlementError';
  }
}
