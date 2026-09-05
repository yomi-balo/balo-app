/**
 * BAL-540 — `POST /meetings/cancelled-teardown`: the post-commit half of the request-close
 * cascade's meeting cancellations. Internal-auth only — the SAME `x-internal-api-key` +
 * `timingSafeEqual` posture as `POST /credit/setup-intent` (`routes/credit/setup-intent.ts:43`) —
 * because this is a system consequence of a `@balo/db` transaction that already committed, never
 * a user act.
 *
 * ── WHY THIS ROUTE EXISTS RATHER THAN REUSING `POST /meetings/:meetingId/cancel` ──────────────
 * The cascade already flipped every meeting row to `cancelled` INSIDE its own transaction
 * (D4 — `@balo/db`'s `close()`). Calling the shipped per-meeting cancel endpoint afterward is not
 * merely redundant: the cascade already committed the state change, so `resolveCancelRefusal`
 * would see `status: 'cancelled'` and answer `409 meeting_not_cancellable` before doing anything
 * — and `CANCEL_USER_RATE_LIMIT` (20/user/hour) would cap a user at roughly 3 closes an hour.
 * This route performs ONLY the two side effects the commit still owes: the availability-cache
 * rebuild and the Daily room teardown. Both are safe by STATE (see
 * `tearDownCancelledMeetings`'s docblock) — every entry is re-read and skipped unless it is
 * already `cancelled` in Postgres, so a caller cannot use this route to cancel anything.
 *
 * ⚠ The static `/meetings/cancelled-teardown` segment cannot be shadowed by the parametric
 * `/meetings/:meetingId/...` routes — different path depth, and Fastify prefers a static route
 * over a parametric one at the same position regardless of registration order.
 */
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@balo/shared/logging';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { parseBodyOr400 } from '../../lib/route-helpers.js';
import { tearDownCancelledMeetings } from '../../services/meetings/meeting-availability.js';
import { cancelledTeardownBodySchema } from './cancelled-teardown.schema.js';

const log = createLogger('meeting-cancelled-teardown-route');

export async function meetingCancelledTeardownRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/meetings/cancelled-teardown',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const body = parseBodyOr400(cancelledTeardownBodySchema, request, reply);
      if (body === null) return;

      const { processed, skipped } = await tearDownCancelledMeetings(body.meetings, request.log);

      log.info({ processed, skipped }, 'Cancelled-meeting teardown batch processed');

      reply.code(200).send({ processed, skipped });
    }
  );
}
