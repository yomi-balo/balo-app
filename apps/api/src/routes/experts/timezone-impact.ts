import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidTimezone } from '@balo/shared/timezone';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import type { RateLimitConfig } from '../../lib/rate-limiter.js';
import { enforceRateLimitFailOpen } from '../../lib/rate-limit-fail-open.js';
import { findTimezoneImpact } from '../../services/availability/timezone-impact.js';

const querySchema = z.object({
  expertProfileId: z.uuid(),
  // The calling session's own `users.id`, asserted against the profile's owner before any
  // client company name is read.
  userId: z.uuid(),
  timezone: z.string().max(64).refine(isValidTimezone, 'Invalid timezone'),
});

// Keyed on the caller's OWN `userId`, never the target `expertProfileId`: keying on the
// target would let a holder of the internal secret burn a real expert's bucket with a bogus
// `userId`.
const TIMEZONE_IMPACT_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:timezone-impact',
  maxRequests: 30,
  windowSeconds: 60,
};

// Allow-listed: no `meetingId`, no rate/margin/fee fields.
interface AffectedConsultationDto {
  consultationId: string;
  startAt: string;
  endAt: string;
  clientCompanyName: string | null;
}

export function timezoneImpactRoute(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/experts/timezone-impact?expertProfileId=&userId=&timezone=
   * Which upcoming confirmed consultations would fall outside the expert's saved weekly
   * hours if those hours were re-read in `timezone`? Read-only; the dialog that asks is a
   * warning, so the web caller fails open on any error here.
   */
  fastify.get(
    '/api/experts/timezone-impact',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const { expertProfileId, userId, timezone } = parsed.data;

      if (
        await enforceRateLimitFailOpen(
          request,
          reply,
          TIMEZONE_IMPACT_RATE_LIMIT,
          userId,
          'timezone-impact rate limit'
        )
      ) {
        return;
      }

      try {
        const result = await findTimezoneImpact({
          expertProfileId,
          userId,
          proposedTimezone: timezone,
        });

        if (result.outcome === 'expert_not_found') {
          request.log.warn({ expertProfileId }, 'Timezone-impact check: expert profile not found');
          return reply.status(404).send({ error: 'Expert profile not found' });
        }

        if (result.truncated) {
          request.log.info(
            {
              expertProfileId,
              affectedCount: result.affectedCount,
              detailCount: result.affected.length,
            },
            'Timezone-impact check truncated the detail list'
          );
        }

        const affected: AffectedConsultationDto[] = result.affected.map((c) => ({
          consultationId: c.consultationId,
          startAt: c.startAt.toISOString(),
          endAt: c.endAt.toISOString(),
          clientCompanyName: c.clientCompanyName,
        }));

        return reply.send({
          timezone: result.timezone,
          affectedCount: result.affectedCount,
          truncated: result.truncated,
          affected,
          nextTimeOff: result.nextTimeOff,
        });
      } catch (error: unknown) {
        request.log.error(
          {
            expertProfileId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Failed to check timezone impact'
        );
        return reply.status(500).send({ error: 'Failed to check timezone impact' });
      }
    }
  );
  return Promise.resolve();
}
