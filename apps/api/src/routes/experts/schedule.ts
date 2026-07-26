import type { FastifyInstance, FastifyReply, FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  availabilityRulesRepository,
  db,
  expertsRepository,
  usersRepository,
  recordScheduleAudit,
  type ExpertProfile,
} from '@balo/db';
import { isValidTimezone } from '@balo/shared/timezone';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { enqueueAvailabilityCacheRebuild } from '../../services/availability/enqueue-rebuild.js';

// ── Validation schemas ──────────────────────────────────────────

/** Wall-clock time on a 15-minute boundary. Linear regex (no ReDoS). */
const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, 'Time must be HH:mm on a 15-minute boundary');

const ruleSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: HHMM,
    endTime: HHMM,
  })
  .refine((r) => r.startTime < r.endTime, { message: 'startTime must be before endTime' });

// `isValidTimezone` accepts every zone from `Intl.supportedValuesOf('timeZone')`
// plus the special-cased 'UTC' (which Node omits). 'UTC' is the
// `expert_profiles.timezone` column default, so it must validate — otherwise an
// expert who never changes their timezone can't save their schedule.
const timezoneSchema = z.string().refine(isValidTimezone, 'Invalid timezone');

// Bounds mirror the CHECK constraints on `expert_profiles` (BAL-234). No
// booking-window field: the look-ahead horizon is platform config (BAL-398).
const bookingSettingsSchema = z.object({
  bufferBeforeMinutes: z.number().int().min(0).max(120),
  bufferAfterMinutes: z.number().int().min(0).max(120),
  minimumNoticeMinutes: z.number().int().min(0).max(20160), // ≤ 14 days
});

const paramsSchema = z.object({ expertProfileId: z.string().uuid() });

// The acting user's id, threaded from the web server action for ADR-1030 audit
// attribution ONLY (never authorization — the IDOR gate is the session-derived
// expertProfileId in the web action). Optional so a caller that omits it records a
// null-actor audit row rather than 400ing.
const actorUserIdSchema = z.string().uuid().optional();

const postBodySchema = z.object({
  timezone: timezoneSchema,
  bookingSettings: bookingSettingsSchema,
  rules: z.array(ruleSchema).max(21), // ≤ 3 ranges × 7 days
  actorUserId: actorUserIdSchema,
});

const patchTzSchema = z.object({ timezone: timezoneSchema, actorUserId: actorUserIdSchema });

// DELETE carries no JSON body (empty-body + json content-type is fragile), so the
// actor rides a query param instead.
const deleteQuerySchema = z.object({ actorUserId: actorUserIdSchema });

// ── Helpers ─────────────────────────────────────────────────────

type ParseResult<T> = { ok: true; data: T } | { ok: false };

/**
 * Validate `input` against `schema`. On failure, send a 400 with the Zod issue
 * messages and return `{ ok: false }`; on success return the parsed data. Shared
 * across all four handlers so the parse-then-400 block isn't duplicated.
 */
function parseOrReply<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  reply: FastifyReply,
  errorLabel: string
): ParseResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.status(400).send({
      error: errorLabel,
      details: parsed.error.issues.map((i) => i.message),
    });
    return { ok: false };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Load the expert profile, or send a 404 and return null so the mutation handlers
 * short-circuit before touching the DB or the queue. Returns the row (not a bool)
 * so callers get `userId` (to keep users.timezone in sync) and the prior
 * `timezone` (for the audit metadata) without a second read.
 */
async function loadProfileOr404(
  expertProfileId: string,
  reply: FastifyReply
): Promise<ExpertProfile | null> {
  const profile = await expertsRepository.findProfileById(expertProfileId);
  if (!profile) {
    reply.status(404).send({ error: 'Expert profile not found' });
    return null;
  }
  return profile;
}

/** Log an error and send the standard 500. Returns the reply to `return`. */
function replyServerError(
  reply: FastifyReply,
  log: FastifyBaseLogger,
  expertProfileId: string,
  err: unknown,
  logMessage: string,
  clientMessage: string
): FastifyReply {
  log.error(
    { expertProfileId, error: err instanceof Error ? err.message : String(err) },
    logMessage
  );
  return reply.status(500).send({ error: clientMessage });
}

/** Trim Postgres `time` (`'HH:mm:ss'`) back to the editor's `'HH:mm'`. */
function toHHMM(time: string): string {
  return time.slice(0, 5);
}

// ── Routes ──────────────────────────────────────────────────────

export async function scheduleRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/experts/:expertProfileId/schedule
   * Returns the expert's timezone, booking settings, and weekly rules.
   * Booking settings fall back to the profile column defaults when unset.
   */
  fastify.get(
    '/api/experts/:expertProfileId/schedule',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const params = parseOrReply(paramsSchema, request.params, reply, 'Invalid path parameters');
      if (!params.ok) return reply;

      const { expertProfileId } = params.data;

      try {
        // Column-projected read (timezone + the 3 booking columns) — never hydrate
        // the full expert_profiles row, which carries stripeConnectId / tokens.
        const [settings, rules] = await Promise.all([
          expertsRepository.findResolverSettings(expertProfileId),
          availabilityRulesRepository.listByExpertProfileId(expertProfileId),
        ]);

        if (!settings) {
          return reply.status(404).send({ error: 'Expert profile not found' });
        }

        return reply.send({
          timezone: settings.timezone,
          bookingSettings: {
            bufferBeforeMinutes: settings.bufferBeforeMinutes,
            bufferAfterMinutes: settings.bufferAfterMinutes,
            minimumNoticeMinutes: settings.minimumNoticeMinutes,
          },
          rules: rules.map((r) => ({
            dayOfWeek: r.dayOfWeek,
            startTime: toHHMM(r.startTime),
            endTime: toHHMM(r.endTime),
          })),
        });
      } catch (err: unknown) {
        return replyServerError(
          reply,
          request.log,
          expertProfileId,
          err,
          'Failed to fetch expert schedule',
          'Failed to fetch schedule'
        );
      }
    }
  );

  /**
   * POST /api/experts/:expertProfileId/schedule
   * Cascade: (1) in one transaction, update the timezone + booking columns then
   * replace the weekly rules; (2) after commit, enqueue the availability-cache
   * rebuild. The enqueue is never skipped — otherwise `earliest_available_at`
   * goes stale.
   */
  fastify.post(
    '/api/experts/:expertProfileId/schedule',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const params = parseOrReply(paramsSchema, request.params, reply, 'Invalid path parameters');
      if (!params.ok) return reply;

      const body = parseOrReply(postBodySchema, request.body, reply, 'Invalid request body');
      if (!body.ok) return reply;

      const { expertProfileId } = params.data;
      const { timezone, bookingSettings, rules, actorUserId } = body.data;

      try {
        const profile = await loadProfileOr404(expertProfileId, reply);
        if (!profile) return reply;
        const oldTimezone = profile.timezone;

        await db.transaction(async (tx) => {
          await expertsRepository.updateProfile(
            expertProfileId,
            {
              timezone,
              bookingBufferBeforeMinutes: bookingSettings.bufferBeforeMinutes,
              bookingBufferAfterMinutes: bookingSettings.bufferAfterMinutes,
              bookingMinimumNoticeMinutes: bookingSettings.minimumNoticeMinutes,
            },
            tx
          );
          await availabilityRulesRepository.replaceForExpert(expertProfileId, rules, tx);
          // Keep the public-display timezone (users.timezone → country/countryCode)
          // in lock-step with the resolver timezone (expert_profiles.timezone), in
          // the SAME transaction so they can never diverge.
          await usersRepository.updateTimezone(profile.userId, timezone, tx);
          await recordScheduleAudit(tx, {
            actorUserId: actorUserId ?? null,
            action: 'expert_schedule.updated',
            expertProfileId,
            metadata: {
              oldTimezone,
              newTimezone: timezone,
              daysEnabled: new Set(rules.map((r) => r.dayOfWeek)).size,
              ruleCount: rules.length,
            },
          });
        });

        await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);

        return reply.send({ success: true, timezone, bookingSettings, rules });
      } catch (err: unknown) {
        return replyServerError(
          reply,
          request.log,
          expertProfileId,
          err,
          'Failed to save expert schedule',
          'Failed to save schedule'
        );
      }
    }
  );

  /**
   * DELETE /api/experts/:expertProfileId/schedule
   * Clears the weekly schedule (soft-deletes all active rules) then enqueues
   * the availability-cache rebuild (earliest becomes null).
   */
  fastify.delete(
    '/api/experts/:expertProfileId/schedule',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const params = parseOrReply(paramsSchema, request.params, reply, 'Invalid path parameters');
      if (!params.ok) return reply;

      const query = parseOrReply(deleteQuerySchema, request.query, reply, 'Invalid query');
      if (!query.ok) return reply;

      const { expertProfileId } = params.data;
      const { actorUserId } = query.data;

      try {
        if (!(await loadProfileOr404(expertProfileId, reply))) return reply;

        await db.transaction(async (tx) => {
          await availabilityRulesRepository.deleteAllForExpert(expertProfileId, tx);
          await recordScheduleAudit(tx, {
            actorUserId: actorUserId ?? null,
            action: 'expert_schedule.cleared',
            expertProfileId,
          });
        });
        await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);

        return reply.send({ success: true });
      } catch (err: unknown) {
        return replyServerError(
          reply,
          request.log,
          expertProfileId,
          err,
          'Failed to clear expert schedule',
          'Failed to clear schedule'
        );
      }
    }
  );

  /**
   * PATCH /api/experts/:expertProfileId/timezone
   * Timezone-only change (no rule change) → enqueue rebuild. Backs the timezone
   * bar's "Change" affordance when working hours are untouched.
   */
  fastify.patch(
    '/api/experts/:expertProfileId/timezone',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const params = parseOrReply(paramsSchema, request.params, reply, 'Invalid path parameters');
      if (!params.ok) return reply;

      const body = parseOrReply(patchTzSchema, request.body, reply, 'Invalid request body');
      if (!body.ok) return reply;

      const { expertProfileId } = params.data;
      const { timezone, actorUserId } = body.data;

      try {
        const profile = await loadProfileOr404(expertProfileId, reply);
        if (!profile) return reply;
        const oldTimezone = profile.timezone;

        await db.transaction(async (tx) => {
          await expertsRepository.updateProfile(expertProfileId, { timezone }, tx);
          // Mirror the tz change into users.timezone (+ derived country) so the
          // public profile location doesn't go stale — same tx as above.
          await usersRepository.updateTimezone(profile.userId, timezone, tx);
          await recordScheduleAudit(tx, {
            actorUserId: actorUserId ?? null,
            action: 'expert_timezone.changed',
            expertProfileId,
            metadata: { oldTimezone, newTimezone: timezone },
          });
        });
        await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);

        return reply.send({ success: true });
      } catch (err: unknown) {
        return replyServerError(
          reply,
          request.log,
          expertProfileId,
          err,
          'Failed to update expert timezone',
          'Failed to update timezone'
        );
      }
    }
  );
}
