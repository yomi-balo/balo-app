import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { createSetupIntent } from '../../services/stripe/mandate.js';

const setupIntentBodySchema = z.object({
  walletId: z.uuid(),
});

/**
 * BAL-383 continue-to-mandate seam. A JSON, internal-auth-only endpoint the web
 * `startContinueToMandate` Server Action calls (apps/web on Vercel cannot import apps/api
 * on Railway, so the seam is an internal HTTP hop — the established
 * `publishNotificationEvent` → `requireInternalAuth` pattern).
 *
 * It creates an `off_session` SetupIntent for the wallet's REUSABLE mandate
 * (`createSetupIntent`, BAL-382) and returns the `client_secret` for the browser to
 * confirm the card. This route NEVER writes mandate state — the BAL-382
 * `setup_intent.succeeded` webhook persists customer/PM/mandate ref + `mandate_status`.
 *
 * Registered by the `stripeRoutes` plugin OUTSIDE the raw-body scope: only
 * `/webhooks/stripe` needs the raw body; a sibling JSON route parses JSON normally.
 */
export async function stripeSetupIntentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/stripe/setup-intent',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = setupIntentBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_payload',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const { clientSecret, setupIntentId } = await createSetupIntent(parsed.data.walletId);
      return reply.send({ clientSecret, setupIntentId });
    }
  );
}
