import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
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

      if (parsed.data.paymentMethodSource === 'saved_card') {
        // `succeeded` ⇒ nothing for the browser to do (the webhook activates the mandate);
        // `requires_action` ⇒ the client secret comes back for `stripe.handleNextAction`.
        const result = await confirmSavedCardMandate(parsed.data.walletId);
        return reply.send(result);
      }

      const { clientSecret, setupIntentId, customerId } = await createSetupIntent(
        parsed.data.walletId
      );

      return reply.send({ clientSecret, setupIntentId, customerId });
    }
  );
}
