/**
 * BAL-254 — `apps/api/src/routes/project-briefs/`, a NEW plugin folder. Modelled verbatim on
 * `routes/admin/index.ts`'s auth preamble.
 */
import type { FastifyInstance } from 'fastify';
import { projectBriefParsesRepository } from '@balo/db';
import { MAX_PARSES_PER_HOUR } from '@balo/shared/project-requests';
import { createLogger } from '@balo/shared/logging';
import { requireAuth } from '../../lib/require-auth.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import { createRateLimitPreHandler } from '../../lib/rate-limit-prehandler.js';
import { enqueueProjectBriefParse } from '../../jobs/project-brief-parse.js';
import { enqueueParseBodySchema } from './schema.js';

const log = createLogger('project-briefs-routes');

/**
 * `failOpen: false` — the cost of a miss here is a paid model call (the vendor round-trip
 * argument, not the search-route "cheap Postgres read" one). `identifier` is the internal user
 * UUID `requireAuth` resolves, so `logIdentifier: true` is safe (never a raw client IP).
 */
const briefParseRateLimit = createRateLimitPreHandler({
  config: { keyPrefix: 'brief-parse', maxRequests: MAX_PARSES_PER_HOUR, windowSeconds: 3600 },
  failOpen: false,
  label: 'project-brief-parse',
  identifier: (request) => request.userId,
  logIdentifier: true,
});

/**
 * POST /project-briefs/parse — enqueue an already-validated brief parse (BAL-254 D1/D9).
 *
 * `requireAuth`, NOT `requireInternalAuth` — the route resolves `request.userId` from the
 * bearer and looks the row up by `(parseId, requestedByUserId)`, an INDEPENDENT identity check
 * `requireInternalAuth` could not provide (D9). No R2 key ever crosses the wire: the body is
 * `{ parseId }` alone (D1) — the worker reads keys from the row.
 */
export async function projectBriefRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/project-briefs/parse',
    { preHandler: [requireAuth, briefParseRateLimit] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const body = parseBodyOr400(enqueueParseBodySchema, request, reply);
      if (body === null) return;

      const row = await projectBriefParsesRepository.findForRequester({
        parseId: body.parseId,
        requestedByUserId: userId,
      });
      if (row === undefined) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (row.completedAt !== null) {
        reply.code(409).send({ error: 'already_completed' });
        return;
      }

      try {
        await enqueueProjectBriefParse({ parseId: body.parseId });
      } catch (error) {
        // ⚠ `err`, NOT a hand-flattened `{ error: message, stack }` (BAL-254 W6). Pino's default
        // `err` serializer keeps type/message/stack/cause; the flattened form collapsed a
        // non-`Error` rejection — which ioredis/BullMQ can and do produce — to the string
        // `[object Object]` with `stack: undefined`, i.e. to nothing actionable at all. Nothing
        // leaks here: the payload this throws over is `{ parseId }` and carries no R2 key and
        // no model output, and `REDACT_PATHS` covers `err.*` credential shapes regardless.
        log.error(
          { err: error, parseId: body.parseId, userId },
          'Failed to enqueue project brief parse'
        );
        reply.code(503).send({ error: 'enqueue_failed' });
        return;
      }

      reply.code(202).send({ enqueued: true });
    }
  );
}
