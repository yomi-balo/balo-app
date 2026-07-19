import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { createSetupIntent } from '../../services/stripe/index.js';

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

      const { clientSecret, setupIntentId, customerId } = await createSetupIntent(
        parsed.data.walletId
      );

      return reply.send({ clientSecret, setupIntentId, customerId });
    }
  );
}
