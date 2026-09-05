import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { enforceMandateSetupRateLimit } from '../../lib/setup-intent-rate-limit.js';
import { createSetupIntent } from '../../services/stripe/mandate.js';

const setupIntentBodySchema = z.object({
  walletId: z.uuid(),
  /**
   * BAL-522 (D2) — the session-resolved actor, threaded to `ensureCustomer` so it can seed the
   * company's billing email on this touch. REQUIRED, so the seam is fail-closed.
   */
  actorUserId: z.uuid(),
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
 *
 * BAL-527 — guarded by `enforceMandateSetupRateLimit` (the SAME per-wallet bucket
 * `routes/credit/setup-intent.ts` uses; see `lib/setup-intent-rate-limit.ts`'s module docblock).
 * This is the redeem path the original ticket never named (a wallet's third production entry
 * point into `createSetupIntent`) — covering it is why the guard lives at the shared choke
 * point rather than being bolted onto one route.
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

      // ⚠ AFTER the cheap validation, BEFORE any Stripe or database work — a malformed request
      // must not burn a wallet's window, and a limited request must cost no vendor call at all.
      if (await enforceMandateSetupRateLimit(parsed.data.walletId, reply)) return;

      const { clientSecret, setupIntentId } = await createSetupIntent(
        parsed.data.walletId,
        parsed.data.actorUserId
      );
      return reply.send({ clientSecret, setupIntentId });
    }
  );
}
