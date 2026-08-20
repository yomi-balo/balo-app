import type { FastifyInstance } from 'fastify';
import { expertsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type {
  AvailabilitySlotDto,
  ExpertAvailabilityResponse,
  ExpertAvailabilityUnavailableResponse,
} from '@balo/shared/availability';
import type { RateLimitConfig } from '../../lib/rate-limiter.js';
import { createRateLimitPreHandler } from '../../lib/rate-limit-prehandler.js';
import { getExpertSlots } from '../../services/availability/expert-slots-cache.js';
import type { BookableSlot } from '../../services/availability/slot-grid.js';
import { availabilityParamsSchema, availabilityQuerySchema } from './availability.schema.js';

const log = createLogger('expert-availability-route');

/**
 * 30/min/IP, FAIL-CLOSED on a Redis error (plan §3.6). This endpoint's cost per miss is a
 * third-party vendor round-trip, and the response cache sitting in front of it is ALSO Redis —
 * so a Redis outage removes the cache and the limiter at the same moment, turning every
 * request into a live Apiroc fan-out. The limiter is the only thing bounding vendor spend
 * here, unlike `/experts/search` (fail-open — a cheap Postgres read).
 */
const RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:expert-availability',
  maxRequests: 30,
  windowSeconds: 60,
};

const VENDOR_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/** `BookableSlot` (internal, UTC `Date`s) → the wire DTO (ISO strings). */
function toSlotDto(slot: BookableSlot): AvailabilitySlotDto {
  const end = new Date(slot.startAt.getTime() + slot.maxDurationMinutes * 60_000);
  return {
    start: slot.startAt.toISOString(),
    end: end.toISOString(),
    maxDuration: slot.maxDurationMinutes,
  };
}

const availabilityRateLimit = createRateLimitPreHandler({
  config: RATE_LIMIT,
  failOpen: false,
  label: 'expert-availability',
});

export async function availabilityRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/experts/:expertProfileId/availability',
    // ⚠ EXPLICIT — `expertsRoutes` has no plugin-level auth hook, so a route registered
    // without a `preHandler` is silently public. This route IS public on purpose (D6); the
    // rate limit is what keeps it from being an unbounded vendor-spend + enumeration surface.
    { preHandler: [availabilityRateLimit] },
    async (
      request,
      reply
    ): Promise<ExpertAvailabilityResponse | ExpertAvailabilityUnavailableResponse | undefined> => {
      const paramsParsed = availabilityParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        reply
          .header('Cache-Control', 'no-store')
          .status(400)
          .send({
            error: 'invalid_request',
            details: paramsParsed.error.issues.map((i) => i.message),
          });
        return undefined;
      }
      const queryParsed = availabilityQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        reply
          .header('Cache-Control', 'no-store')
          .status(400)
          .send({
            error: 'invalid_request',
            details: queryParsed.error.issues.map((i) => i.message),
          });
        return undefined;
      }

      const { expertProfileId } = paramsParsed.data;
      const { days } = queryParsed.data;
      const now = new Date();

      try {
        // ⚠ THE FIRST READ, DELIBERATELY (plan §3.3). An enumeration probe against a random
        // uuid costs exactly one indexed PK lookup — no vendor round-trip, no four-way fan-out.
        const visible = await expertsRepository.isPubliclyVisible(expertProfileId);
        if (!visible) {
          reply.header('Cache-Control', 'no-store').status(404).send({ error: 'not_found' });
          return undefined;
        }

        const result = await getExpertSlots(expertProfileId, now);

        if (result.status === 'expert_not_found') {
          // Profile vanished between the visibility read and the settings read.
          reply.header('Cache-Control', 'no-store').status(404).send({ error: 'not_found' });
          return undefined;
        }

        if (result.status === 'unavailable') {
          reply
            .header('Cache-Control', 'no-store')
            .header('Retry-After', String(VENDOR_UNAVAILABLE_RETRY_AFTER_SECONDS))
            .status(503)
            .send({
              status: 'unavailable',
              retryAfterSeconds: VENDOR_UNAVAILABLE_RETRY_AFTER_SECONDS,
            } satisfies ExpertAvailabilityUnavailableResponse);
          return undefined;
        }

        // ⚠ ANCHORED AT `generatedAt`, NOT AT THIS REQUEST'S `now`. The cached grid's horizon
        // was measured from the instant it was computed, so on a cache hit anchoring here would
        // claim a window edge up to the TTL beyond what was actually computed.
        const windowEnd = new Date(result.generatedAt.getTime() + days * 24 * 60 * 60 * 1000);
        const slots = result.slots
          .filter((s) => s.startAt.getTime() < windowEnd.getTime())
          .map(toSlotDto);

        // ⚠ STATUS IS DERIVED AFTER THE WINDOW FILTER. `ok` with an empty `slots` is otherwise
        // reachable in NORMAL operation — an expert whose next free slot sits beyond `days`
        // would send the client down its `ready` branch with nothing to render and no highlighted
        // day, silently bypassing the purpose-built `no_slots` empty state. "Branch on status,
        // never on an empty array" only works if the status describes what was actually sent.
        const status = result.status === 'ok' && slots.length === 0 ? 'no_slots' : result.status;

        const response: ExpertAvailabilityResponse = {
          expertProfileId,
          status,
          expertTimezone: result.expertTimezone,
          generatedAt: result.generatedAt.toISOString(),
          windowEnd: windowEnd.toISOString(),
          days,
          slots,
        };

        // Cache hit iff the served computation ran for an earlier request (its `generatedAt`
        // differs from THIS request's `now`) — a fresh compute always stamps `generatedAt`
        // bit-for-bit equal to the `now` it was given.
        const cacheHit = result.generatedAt.getTime() !== now.getTime();
        log.info(
          { expertProfileId, status, slotCount: slots.length, days, cacheHit },
          'Expert availability served'
        );

        reply.header('Cache-Control', 'public, max-age=60');
        return response;
      } catch (error) {
        log.error(
          {
            expertProfileId,
            days,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Expert availability failed'
        );
        reply
          .header('Cache-Control', 'no-store')
          .status(500)
          .send({ error: 'availability_failed' });
        return undefined;
      }
    }
  );
}
