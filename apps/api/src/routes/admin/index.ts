/**
 * BAL-550 — `apps/api/src/routes/admin/`, a NEW plugin folder. The money-block admin route
 * (`GET /admin/sessions/:id/money-block`) predates this folder and is deliberately left where
 * it is (`routes/sessions/index.ts`) — not moved here, to keep this PR's diff to the surface it
 * actually owns.
 */
import type { FastifyInstance } from 'fastify';
import { usersRepository } from '@balo/db';
import { platformRoleHasCapability, PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { requireAuth } from '../../lib/require-auth.js';
import { parseParamsOr400, resolveUserId } from '../../lib/route-helpers.js';
import { performRedrive } from '../../services/admin/redrive.js';
import { redriveParamsSchema } from './schema.js';

const log = createLogger('admin-routes');

/**
 * POST /admin/redrive/:kind/:id — BAL-550. Re-drive a stuck capture-pipeline job from the
 * `/admin/health/capture` lens. `super_admin` ONLY (`REDRIVE_JOB`).
 *
 * Authorization copies `GET /admin/sessions/:id/money-block` (`routes/sessions/index.ts`)
 * VERBATIM, only the token swapped: `requireAuth` → params parse → LIVE
 * `usersRepository.findById` → `platformRoleHasCapability(user.platformRole, REDRIVE_JOB)` →
 * `log.warn` + `403`. NEVER a cookie-carried role — the cookie's `platformRole` can be stale
 * for up to its session lifetime; a demoted admin must lose this the moment their row changes.
 *
 * No rate limiter: the CAS is the real bound (a re-drive is not repeatable without a NEW
 * failure), the token is `super_admin`-only, and every attempt is audited.
 */
export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/admin/redrive/:kind/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const params = parseParamsOr400(redriveParamsSchema, request, reply);
      if (params === null) return;

      const user = await usersRepository.findById(userId);
      if (
        user === undefined ||
        !platformRoleHasCapability(user.platformRole, PLATFORM_CAPABILITIES.REDRIVE_JOB)
      ) {
        log.warn(
          { kind: params.kind, entityId: params.id, userId },
          'Admin re-drive denied — lacks platform capability'
        );
        reply.code(403).send({ error: 'forbidden' });
        return;
      }

      try {
        const outcome = await performRedrive({
          kind: params.kind,
          entityId: params.id,
          actorUserId: userId,
        });

        if (!outcome.ok) {
          if (outcome.code === 'not_redrivable') {
            reply.code(409).send({ error: 'not_redrivable' });
            return;
          }
          reply.code(502).send({ error: 'enqueue_failed', auditEventId: outcome.auditEventId });
          return;
        }

        reply.code(200).send({
          kind: outcome.kind,
          entityId: outcome.entityId,
          auditEventId: outcome.auditEventId,
          jobId: outcome.jobId,
        });
      } catch (error) {
        log.error(
          {
            kind: params.kind,
            entityId: params.id,
            userId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Failed to perform admin re-drive'
        );
        reply.code(503).send({ error: 'redrive_unavailable' });
      }
    }
  );
}
