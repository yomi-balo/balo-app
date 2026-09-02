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

/**
 * BAL-515 — the webhook's transaction did not commit, or its marker is invisible. Thrown so the
 * route CANNOT ack 200 on work that may not exist; the app error handler (`app.ts`) captures it
 * to Sentry and answers 500, which makes Stripe redeliver.
 *
 * ⚠ THERE IS DELIBERATELY NO RETRY COUNTER THAT EVENTUALLY ACKS. Acking a money effect that may
 * not exist IS the incident this ticket closes. A repeated `StripeWebhookCommitProofError` in
 * Sentry is the correct, human-visible end state; the route's `log.error` puts the rate in Axiom
 * before Sentry even fires. Do not "fix" that noise by acking.
 */
export class StripeWebhookCommitProofError extends Error {
  constructor(
    eventId: string,
    eventType: string,
    stage: 'mark_processed' | 'post_commit_readback'
  ) {
    super(
      `Stripe webhook commit proof failed at ${stage}: event ${eventId} (${eventType}) has no processed_at`
    );
    this.name = 'StripeWebhookCommitProofError';
  }
}
