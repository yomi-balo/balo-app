import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { enforceMandateSetupRateLimit } from '../../lib/setup-intent-rate-limit.js';
import { createSetupIntent, confirmSavedCardMandate } from '../../services/stripe/index.js';

/**
 * Body for `POST /credit/setup-intent` (BAL-377). Captures a REUSABLE off-session card
 * mandate: the provider marks the wallet `mandate_status = 'pending'` and returns the
 * `client_secret` for the frontend to confirm the card; the webhook `setup_intent.succeeded`
 * → `applyMandate` persists the customer + payment method + mandate ref and flips the status
 * to `'active'`. Used when the buyer selects a card-backed low-balance mode (Keep me going /
 * Auto top-up), confirmed alongside the PaymentIntent in the same Pay step.
 */
const setupIntentBodySchema = z.object({
  walletId: z.uuid(),
  /**
   * Top-up redesign — which card the mandate is captured against. `new_card` (default) keeps
   * the shipped behaviour: return a client secret for the browser to confirm with the card the
   * buyer just entered. `saved_card` confirms server-side against the wallet's ALREADY-STORED
   * payment method (the "card on file from a `notify_only` purchase, buyer now picks a
   * card-backed mode" case), so the buyer never re-enters a card they already gave us.
   */
  paymentMethodSource: z.enum(['new_card', 'saved_card']).default('new_card'),
  /**
   * Keys the saved-card SetupIntent's Stripe idempotency (the create lives in
   * `confirmSavedCardMandate`; previously unkeyed, so a retried Server Action minted duplicate
   * SetupIntents). Same id as the purchase's, so it inherits the composer's rotation rules
   * (new id per configuration AND per decline). Required exactly when it is used.
   */
  clientRequestId: z.uuid().optional(),
  /**
   * BAL-522 (D2) — the session-resolved actor, threaded to `ensureCustomer` so it can seed the
   * company's billing email on this touch. REQUIRED (not optional) so the seam is fail-closed:
   * an omitted actor would make the seed silently never happen. The `saved_card` arm does not
   * reach `ensureCustomer` today, but the field stays required so a future arm inherits it.
   */
  actorUserId: z.uuid(),
});

export async function setupIntentRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/credit/setup-intent',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = setupIntentBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_payload',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const { walletId, paymentMethodSource, clientRequestId, actorUserId } = parsed.data;

      // The `saved_card` arm's extra requirement, resolved BEFORE the arm dispatch so the rate
      // limit below has exactly ONE call site (fix round: it was duplicated into both arms).
      // `null` ⇒ this is the `new_card` arm; `undefined` ⇒ `saved_card` with no id, a 400.
      // Carrying it as a value rather than re-testing `paymentMethodSource` inside the arm is
      // what lets TypeScript narrow it to `string` there without an assertion.
      const savedCardRequestId = paymentMethodSource === 'saved_card' ? clientRequestId : null;
      if (savedCardRequestId === undefined) {
        return reply.status(400).send({
          error: 'invalid_payload',
          details: ['clientRequestId is required for saved_card'],
        });
      }

      // ⚠ AFTER the cheap validation, BEFORE any Stripe or database work — a malformed request
      // must not burn a wallet's window, and a limited request must cost no vendor call at all
      // (`routes/meetings/end.ts` states this ordering rule). BAL-527 Round 2 Q2: BOTH arms share
      // the SAME bucket — `confirmSavedCardMandate`'s own idempotency key is CLIENT-MINTED and
      // therefore rotatable by the caller, so it carries the identical unbounded-mint shape this
      // ticket exists to bound.
      if (await enforceMandateSetupRateLimit(walletId, reply)) return;

      if (savedCardRequestId !== null) {
        // `succeeded` ⇒ nothing for the browser to do (the webhook activates the mandate);
        // `requires_action` ⇒ the client secret comes back for `stripe.handleNextAction`.
        const result = await confirmSavedCardMandate(walletId, savedCardRequestId);
        return reply.send(result);
      }

      const { clientSecret, setupIntentId, customerId } = await createSetupIntent(
        walletId,
        actorUserId
      );

      return reply.send({ clientSecret, setupIntentId, customerId });
    }
  );
}
