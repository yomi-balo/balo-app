import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { availabilityOverridesRepository, type AvailabilityOverride } from '@balo/db';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { enqueueAvailabilityCacheRebuild } from '../../jobs/availability-cache.js';
import { trackServer, AVAILABILITY_SERVER_EVENTS } from '@balo/analytics/server';
import { findOverrideConflicts } from '../../services/availability/override-conflicts.js';
import {
  checkRateLimit,
  RATE_LIMIT_DEADLINE_MS,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { getRedis } from '../../lib/redis.js';
import { withDeadline } from '../../lib/with-deadline.js';

// ── Validation schemas ──────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * S3 — a time-off block (or a conflict-check window) has a sane ceiling; without this an
 * `endDate` of e.g. `9999-12-31` passes validation and turns `listConfirmedInRange` (no
 * `LIMIT`) into an unbounded forward booking-history scan.
 */
const MAX_OVERRIDE_SPAN_DAYS = 366;

/** Inclusive whole-day count of `[startIso, endIso]` (single day = 1). */
function inclusiveDayCount(startIso: string, endIso: string): number {
  const s = Date.parse(`${startIso}T00:00:00Z`);
  const e = Date.parse(`${endIso}T00:00:00Z`);
  return Math.round((e - s) / 86_400_000) + 1;
}

/**
 * SUGGESTION — the `endDate >= startDate` + `MAX_OVERRIDE_SPAN_DAYS` refine pair, shared by
 * every schema in this file with a date range (a create body and a conflicts query today).
 * One definition so the two never drift.
 */
function withDateRangeRules<T extends { startDate: string; endDate: string }>(
  schema: z.ZodType<T>
) {
  return (
    schema
      // String comparison is valid for zero-padded ISO dates.
      .refine((v) => v.endDate >= v.startDate, {
        message: 'End date must be on or after start date',
        path: ['endDate'],
      })
      .refine((v) => inclusiveDayCount(v.startDate, v.endDate) <= MAX_OVERRIDE_SPAN_DAYS, {
        message: `Date range must not exceed ${MAX_OVERRIDE_SPAN_DAYS} days`,
        path: ['endDate'],
      })
  );
}

const listQuerySchema = z.object({ expertProfileId: z.string().uuid() });

const createBodySchema = withDateRangeRules(
  z.object({
    expertProfileId: z.string().uuid(),
    startDate: isoDate,
    endDate: isoDate,
    // Normalize empty/whitespace-only labels to `null` so a blank label never
    // gets stored as `''` (the DTO + card use `label` as `string | null`).
    label: z
      .string()
      .trim()
      .max(80, 'Label must be 80 characters or fewer')
      .optional()
      .transform((v) => (v && v.length > 0 ? v : null)),
  })
);

const deleteBodySchema = z.object({
  expertProfileId: z.string().uuid(),
  overrideId: z.string().uuid(),
});

const conflictsQuerySchema = withDateRangeRules(
  z.object({
    expertProfileId: z.string().uuid(),
    // S1 — the calling session's own `users.id`, asserted against `expertProfiles.userId`
    // before this route's counterparty-identity payload (`clientCompanyName`) is read.
    userId: z.string().uuid(),
    startDate: isoDate,
    endDate: isoDate,
  })
);

// S4 — the prefetch is un-debounced client-side and each call fans out to ~40+ DB round
// trips (settings + consultations + contexts + up to 20 owner reads + up to 20 company
// reads); this is defense in depth behind the client debounce.
//
// ⚠ R3 — KEYED ON `userId` (the caller's OWN identity), NOT `expertProfileId`. Keying on the
// TARGET expert let a secret-holder (anyone who can reach this `requireInternalAuth`-gated
// route directly, bypassing the web session) burn a REAL expert's bucket with a bogus
// `userId` + that expert's `expertProfileId` — a denial-of-service on the expert's own
// legitimate use of this feature. Keying on `userId` instead means an attacker only ever
// exhausts a bucket they themselves picked; the target's bucket is untouched regardless.
//
// ⚠ R3 — 60/60s, not 30/60s. `mode="range"` fires the client's debounced prefetch at least
// twice per completed selection (the intermediate `{from, to: undefined}` state, then the
// full range) — roughly 30 calls/minute from ordinary dragging alone left the old ceiling
// thin enough that a real user's own behaviour could trip it, and a 429 here collapses to
// `null` in the Server Action → D10 fail-open → the warning silently stops appearing.
const CONFLICTS_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:availability-conflicts',
  maxRequests: 60,
  windowSeconds: 60,
};

/**
 * ⚠ R3 — BOUNDED VIA `withDeadline`, NOT A BARE `try/catch`. `getRedis()` sets
 * `maxRetriesPerRequest: null` (BullMQ requires it), and ioredis only fails pending commands
 * with an error when that option is a NUMBER — with `null`, a command issued during a Redis
 * outage is parked in the offline queue and NEVER SETTLES, so an unbounded `await` here would
 * hang the request rather than reach the `catch` below. See `with-deadline.ts`'s docblock for
 * the verified mechanism; six other routes in this app already wrap `checkRateLimit` for
 * exactly this reason.
 *
 * Genuinely fails OPEN once bounded — this is a WARNING read (D10), and refusing it entirely
 * would be new friction from an unrelated failure.
 */
async function enforceConflictsRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<boolean> {
  try {
    const result = await withDeadline(
      () => checkRateLimit(getRedis(), CONFLICTS_RATE_LIMIT, userId),
      { deadlineMs: RATE_LIMIT_DEADLINE_MS, label: 'override-conflicts rate limit' }
    );
    if (!result.allowed) {
      reply
        .header('Retry-After', String(result.ttlSeconds))
        .status(429)
        .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
      return true;
    }
  } catch (err: unknown) {
    request.log.warn(
      { userId, error: err instanceof Error ? err.message : String(err) },
      'Override-conflict rate limit unavailable — failing open'
    );
  }
  return false;
}

// ── Conflicts DTO (allow-listed — no ids beyond the expert's own consultation row, no
// rate/margin/fee; see plan D6) ──

interface ConflictDto {
  consultationId: string;
  startAt: string;
  endAt: string;
  clientCompanyName: string | null;
}

// ── DTO (allow-listed — never leak created/updated/deletedAt) ────

interface OverrideDto {
  id: string;
  startDate: string;
  endDate: string;
  label: string | null;
}

function toDto(o: AvailabilityOverride): OverrideDto {
  return { id: o.id, startDate: o.startDate, endDate: o.endDate, label: o.label };
}

// ── Routes ──────────────────────────────────────────────────────

export async function availabilityOverridesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/experts/availability-overrides?expertProfileId=...
   * Lists an expert's upcoming (non-elapsed, non-deleted) time-off blocks.
   */
  fastify.get(
    '/api/experts/availability-overrides',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const { expertProfileId } = parsed.data;

      try {
        const rows = await availabilityOverridesRepository.listUpcoming(expertProfileId);
        return reply.send({ overrides: rows.map(toDto) });
      } catch (err: unknown) {
        request.log.error(
          { expertProfileId, error: err instanceof Error ? err.message : String(err) },
          'Failed to list availability overrides'
        );
        return reply.status(500).send({ error: 'Failed to list availability overrides' });
      }
    }
  );

  /**
   * POST /api/experts/availability-overrides
   * Creates a time-off block and enqueues an availability-cache rebuild.
   */
  fastify.post(
    '/api/experts/availability-overrides',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const { expertProfileId, startDate, endDate, label } = parsed.data;

      try {
        const override = await availabilityOverridesRepository.create({
          expertProfileId,
          startDate,
          endDate,
          label,
        });

        // Rebuild AFTER the row is committed so the resolver sees the new block.
        await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);

        trackServer(AVAILABILITY_SERVER_EVENTS.OVERRIDE_CREATED, {
          duration_days: inclusiveDayCount(startDate, endDate),
          // `label` is already normalized (empty/whitespace → null) by the schema.
          has_label: label !== null,
          distinct_id: expertProfileId,
        });

        request.log.info(
          { expertProfileId, overrideId: override.id },
          'Availability override created'
        );
        return reply.send({ override: toDto(override) });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Failed to create availability override'
        );
        return reply.status(500).send({ error: 'Failed to create availability override' });
      }
    }
  );

  /**
   * POST /api/experts/availability-overrides/delete
   * Ownership-scoped soft delete (POST-body convention, matches calendar routes).
   * The repo scopes the delete to `expertProfileId`, so it is IDOR-safe.
   */
  fastify.post(
    '/api/experts/availability-overrides/delete',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = deleteBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request body' });
      }

      const { expertProfileId, overrideId } = parsed.data;

      try {
        const deleted = await availabilityOverridesRepository.softDelete(
          overrideId,
          expertProfileId
        );
        if (!deleted) {
          return reply.status(404).send({ error: 'Override not found' });
        }

        await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);

        trackServer(AVAILABILITY_SERVER_EVENTS.OVERRIDE_DELETED, {
          distinct_id: expertProfileId,
        });

        request.log.info({ expertProfileId, overrideId }, 'Availability override deleted');
        return reply.send({ success: true });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            overrideId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to delete availability override'
        );
        return reply.status(500).send({ error: 'Failed to delete availability override' });
      }
    }
  );

  /**
   * GET /api/experts/availability-overrides/conflicts
   * BAL-416 — does a proposed time-off block collide with any confirmed consultation?
   * Read-only: detect-and-warn only, nothing is cancelled or moved. `requireInternalAuth`
   * gates the call as coming from Balo's own web server; the caller's `userId` (the
   * session's own `users.id`, threaded from the web Server Action) is additionally asserted
   * against `expertProfiles.userId` in `findOverrideConflicts` (S1) before this route's
   * counterparty-identity payload (`clientCompanyName`) is read — this is the first sibling
   * in this route family to return cross-party data, so `expertProfileId` alone (caller-
   * supplied, publicly harvestable via `GET /api/experts/search`) is not enough.
   *
   * ⚠ R3 — the rate limit still runs BEFORE the S1 ownership assertion (it is a cheap Redis
   * round trip ahead of the ~40+ DB round trips `findOverrideConflicts` can fan out to, which
   * is the point of gating first). This is safe now that `CONFLICTS_RATE_LIMIT` is keyed on
   * `userId`: a caller who supplies a mismatched `userId` only ever spends their OWN bucket
   * probing, never the real expert's — see the R3 note on `CONFLICTS_RATE_LIMIT` above. A
   * deeper reorder (skip the Redis call entirely for a request that will fail ownership) was
   * considered and deliberately not done — it would require `findOverrideConflicts`'s
   * ownership check to be split out and re-run here too, a second definition of the same
   * `settings.userId !== input.userId` comparison, for a benefit (saving one Redis round
   * trip on an already-doomed request) smaller than the duplication cost.
   */
  fastify.get(
    '/api/experts/availability-overrides/conflicts',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = conflictsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const { expertProfileId, userId, startDate, endDate } = parsed.data;

      if (await enforceConflictsRateLimit(request, reply, userId)) {
        return;
      }

      try {
        const result = await findOverrideConflicts({ expertProfileId, userId, startDate, endDate });

        if (result.outcome === 'expert_not_found') {
          request.log.warn(
            { expertProfileId },
            'Override-conflict check: expert profile not found'
          );
          return reply.status(404).send({ error: 'Expert profile not found' });
        }

        // Q5 — moved from the service so this correlates with `requestId`/`userId` via the
        // AsyncLocalStorage mixin, per D5 and the plan's Observability table.
        if (result.truncated) {
          request.log.info(
            {
              expertProfileId,
              conflictCount: result.conflictCount,
              detailCount: result.conflicts.length,
            },
            'Override-conflict check truncated the detail list'
          );
        }

        const conflicts: ConflictDto[] = result.conflicts.map((c) => ({
          consultationId: c.consultationId,
          startAt: c.startAt.toISOString(),
          endAt: c.endAt.toISOString(),
          clientCompanyName: c.clientCompanyName,
        }));

        return reply.send({
          conflictCount: result.conflictCount,
          durationDays: inclusiveDayCount(startDate, endDate),
          timezone: result.timezone,
          truncated: result.truncated,
          conflicts,
        });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Failed to check time-off conflicts'
        );
        return reply.status(500).send({ error: 'Failed to check time-off conflicts' });
      }
    }
  );
}
