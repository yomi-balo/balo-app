import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { creditWalletsRepository } from '@balo/db';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { ensureCustomer, createOnSessionPurchaseIntent } from '../../services/stripe/index.js';

/**
 * Body for `POST /credit/purchase-intent` (BAL-377). The web Server Action has already
 * resolved the session + gated MANAGE_BILLING + resolved the wallet; this internal route
 * trusts that across the `requireInternalAuth` secret boundary (same trust model as
 * `/notifications/publish`). `clientRequestId` is a UUID minted client-side, STABLE across
 * double-submits of the same configuration → the Stripe idempotency key
 * `purchase:{walletId}:{clientRequestId}` makes a double-click return the SAME PaymentIntent
 * (never a second charge). `promoCode` is optional (unadvertised); it rides into PI metadata
 * so the webhook grants the bonus best-effort on successful payment.
 *
 * DEFENCE-IN-DEPTH (behind `requireInternalAuth`): the amount + currency are re-asserted here,
 * independently of the web limits, so a compromised/misused internal caller can't mint an
 * arbitrary charge. Bounds mirror the web slider (A$300 … A$10,000) and the currency is
 * restricted to the supported allowlist (the charge itself is always AUD at face value).
 */
const MIN_PRESENTMENT_MINOR = 30_000; // A$300 — matches the web MIN_AMOUNT_MINOR
const MAX_PRESENTMENT_MINOR = 1_000_000; // A$10,000 — matches the web MAX_AMOUNT_MINOR
const SUPPORTED_PRESENTMENT_CURRENCIES = ['aud', 'usd', 'gbp', 'eur'] as const;

const purchaseIntentBodySchema = z.object({
  walletId: z.uuid(),
  presentmentCurrency: z
    .string()
    .length(3)
    .transform((c) => c.toLowerCase())
    .refine(
      (c): c is (typeof SUPPORTED_PRESENTMENT_CURRENCIES)[number] =>
        (SUPPORTED_PRESENTMENT_CURRENCIES as readonly string[]).includes(c),
      { message: 'unsupported_currency' }
    ),
  presentmentAmountMinor: z.number().int().min(MIN_PRESENTMENT_MINOR).max(MAX_PRESENTMENT_MINOR),
  initiatingMemberId: z.uuid(),
  clientRequestId: z.uuid(),
  promoCode: z.string().min(1).max(64).optional(),
});

export async function purchaseIntentRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/credit/purchase-intent',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = purchaseIntentBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_payload',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const {
        walletId,
        presentmentCurrency,
        presentmentAmountMinor,
        initiatingMemberId,
        clientRequestId,
        promoCode,
      } = parsed.data;

      const wallet = await creditWalletsRepository.findById(walletId);
      if (wallet === undefined) {
        return reply.status(404).send({ error: 'wallet_not_found' });
      }

      const customerId = await ensureCustomer(wallet);
      const { clientSecret, paymentIntentId } = await createOnSessionPurchaseIntent({
        walletId,
        customerId,
        // Already normalised to lower-case + allowlisted by the schema transform.
        presentmentCurrency,
        presentmentAmountMinor,
        initiatingMemberId,
        idempotencyKey: `purchase:${walletId}:${clientRequestId}`,
        promoCode,
      });

      return reply.send({ clientSecret, paymentIntentId });
    }
  );
}
