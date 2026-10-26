import type { FastifyInstance } from 'fastify';
import { proposalDraftGenerationsRepository } from '@balo/db';
import { DRAFT_DEADLINE_MS, MAX_PROPOSAL_DRAFTS_PER_HOUR } from '@balo/shared/project-requests';
import { createLogger } from '@balo/shared/logging';
import { requireAuth } from '../../lib/require-auth.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import { createRateLimitPreHandler } from '../../lib/rate-limit-prehandler.js';
import { enqueueProposalDraftGenerate } from '../../jobs/proposal-draft-generate.js';
import { enqueueProposalDraftBodySchema } from './schema.js';

const log = createLogger('proposal-drafts-routes');

/**
 * `failOpen: false` — a miss costs a paid model call. `identifier` is the internal user UUID
 * `requireAuth` resolves, so `logIdentifier: true` is safe (never a raw client IP).
 */
const proposalDraftRateLimit = createRateLimitPreHandler({
  config: {
    keyPrefix: 'proposal-draft',
    maxRequests: MAX_PROPOSAL_DRAFTS_PER_HOUR,
    windowSeconds: 3600,
  },
  failOpen: false,
  label: 'proposal-draft-generate',
  identifier: (request) => request.userId,
  logIdentifier: true,
});

/**
 * POST /proposal-drafts/generate — enqueue an already-opened proposal draft generation.
 *
 * `requireAuth` resolves `request.userId` from the bearer, and the route looks the row up by
 * `(generationId, userId)` through the relationship's expert: an identity check independent of
 * the web gate that wrote the row. The body is `{ generationId }` alone; the worker reads
 * everything else from the database.
 */
export async function proposalDraftRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/proposal-drafts/generate',
    { preHandler: [requireAuth, proposalDraftRateLimit] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const body = parseBodyOr400(enqueueProposalDraftBodySchema, request, reply);
      if (body === null) return;

      const row = await proposalDraftGenerationsRepository.findForRelationshipExpert({
        generationId: body.generationId,
        userId,
      });
      if (row === undefined) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      // A pending row past the deadline already reads as failed on the web; enqueueing it would
      // only have the worker abandon it, so it is refused here the same way a settled row is.
      if (row.status !== 'pending' || Date.now() - row.createdAt.getTime() > DRAFT_DEADLINE_MS) {
        reply.code(409).send({ error: 'already_completed' });
        return;
      }

      try {
        await enqueueProposalDraftGenerate({ generationId: body.generationId });
      } catch (error) {
        // `err` keeps the serializer's type/message/stack/cause; a hand-flattened message
        // collapses a non-`Error` rejection (ioredis/BullMQ can produce one) to nothing useful.
        // The enqueue payload is one uuid, so nothing sensitive is logged.
        log.error(
          { err: error, generationId: body.generationId, userId },
          'Failed to enqueue proposal draft generation'
        );
        reply.code(503).send({ error: 'enqueue_failed' });
        return;
      }

      reply.code(202).send({ enqueued: true });
    }
  );
}
