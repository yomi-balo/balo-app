import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { detachSavedCard } from '../../services/stripe/index.js';

/**
 * Body for `POST /credit/payment-method/detach` (BAL-516). O1 — BAL-515 shipped only the
 * INBOUND webhook half of card removal (`payment_method.detached` → `saved_card_detached` →
 * `clearSavedCard`); there was no outbound way to actually detach a payment method at Stripe.
 * This route is that outbound half: the web Server Action (`removeSavedCardAction`) resolves
 * the wallet from the SESSION's company — the `walletId` crossing this internal hop is never
 * client-supplied, matching the trust model documented in `routes/credit/index.ts`.
 *
 * A POST-with-path-verb is chosen over a `DELETE` (O1's example) because the internal hop
 * client (`postInternal`) is POST-only and every sibling internal route is POST, and because
 * DELETE request bodies are proxy-hostile. Boring wins.
 *
 * FIX ROUND 3 (N2) — `actorUserId` follows the `initiatingMemberId` precedent
 * (`purchase-intent.ts`): a required `z.uuid()` in the body, so `detachSavedCard` can append an
 * `audit_events` row naming the actor. It is derived SERVER-SIDE in the web Server Action from
 * the session (`requireBillingActor()`), never from anything the browser supplies directly —
 * the browser only ever triggers the zero-arg `removeSavedCardAction()`.
 */
const paymentMethodDetachBodySchema = z.object({ walletId: z.uuid(), actorUserId: z.uuid() });

export async function paymentMethodRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/credit/payment-method/detach',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = paymentMethodDetachBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_payload',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const result = await detachSavedCard(parsed.data.walletId, parsed.data.actorUserId);

      if (result.status === 'no_wallet') {
        return reply.status(404).send({ error: 'wallet_not_found' });
      }
      // FIX ROUND (security MEDIUM) — refuse removal while the wallet has unsettled consultation
      // time (a live overdraft-grace session, or an open receivable), so a card cannot be pulled
      // mid-consultation to dodge an already-incurred debt.
      if (result.status === 'settlement_outstanding') {
        return reply.status(409).send({ error: 'settlement_outstanding' });
      }
      if (result.status === 'stripe_error') {
        return reply.status(502).send({ error: 'stripe_detach_failed' });
      }

      return reply.send({
        removed: true,
        lowBalanceMode: result.lowBalanceMode,
        modeReconciled: result.modeReconciled,
      });
    }
  );
}
