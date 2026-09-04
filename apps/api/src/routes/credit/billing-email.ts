import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { actorHoldsManageBilling } from '../../services/billing/authorize-billing-actor.js';
import { setCompanyBillingEmail } from '../../services/billing/set-billing-email.js';

/**
 * Body for `POST /credit/billing-email` (BAL-522). The web Server Action has already resolved
 * the session and gated MANAGE_BILLING; `companyId` and `actorUserId` are SERVER-derived there
 * (`requireBillingActor()`), never client-supplied — the same trust model as
 * `/credit/payment-method/detach`'s `walletId`/`actorUserId`. This route re-gates anyway
 * (`actorHoldsManageBilling`) because it mutates a durable, audited company value across the
 * internal-secret boundary, and `companiesRepository.setBillingEmail` re-gates a THIRD time
 * inside its own transaction (the TOCTOU-safe one).
 *
 * ⚠ NOT BLANKABLE (decision 3). `.trim().min(1)` before the email check, so a whitespace-only
 * body is a 400 rather than a silently-cleared billing contact.
 * ⚠ NO case folding — the client sees back exactly what they typed, and Stripe stores it
 * verbatim. `.max(254)` matches every other email bound in this codebase.
 */
const billingEmailBodySchema = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid(),
  billingEmail: z.string().trim().min(1).email().max(254),
});

export async function billingEmailRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/credit/billing-email',
    { preHandler: [requireInternalAuth] },
    async (req, reply) => {
      const parsed = billingEmailBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'invalid_payload', details: parsed.error.issues.map((i) => i.message) });
      }
      const { companyId, actorUserId, billingEmail } = parsed.data;

      if (!(await actorHoldsManageBilling(companyId, actorUserId))) {
        return reply.status(403).send({ error: 'forbidden' });
      }

      const result = await setCompanyBillingEmail({ companyId, actorUserId, billingEmail });
      if (result.status === 'not_found') {
        return reply.status(404).send({ error: 'company_not_found' });
      }
      if (result.status === 'forbidden') {
        return reply.status(403).send({ error: 'forbidden' });
      }

      return reply.send({
        status: result.status, // 'updated' | 'unchanged'
        billingEmail: result.billingEmail,
        setAt: result.setAt?.toISOString() ?? null,
      });
    }
  );
}
