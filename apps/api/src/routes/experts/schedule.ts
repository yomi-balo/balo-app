import type { FastifyInstance, FastifyReply, FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { availabilityRulesRepository, db, expertsRepository } from '@balo/db';
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

const bookingSettingsSchema = z.object({
  bufferBeforeMinutes: z.number().int().min(0).max(120),
  bufferAfterMinutes: z.number().int().min(0).max(120),
  minimumNoticeMinutes: z.number().int().min(0).max(20160), // ≤ 14 days
  windowDays: z.number().int().min(1).max(365),
});

const paramsSchema = z.object({ expertProfileId: z.string().uuid() });

const postBodySchema = z.object({
  timezone: timezoneSchema,
  bookingSettings: bookingSettingsSchema,
  rules: z.array(ruleSchema).max(21), // ≤ 3 ranges × 7 days
});

const patchTzSchema = z.object({ timezone: timezoneSchema });

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
 * Confirm the expert profile exists. On absence, send a 404 and return false so
 * the mutation handlers short-circuit before touching the DB or the queue.
 */
async function ensureProfileExists(expertProfileId: string, reply: FastifyReply): Promise<boolean> {
  const profile = await expertsRepository.findProfileById(expertProfileId);
  if (!profile) {
    reply.status(404).send({ error: 'Expert profile not found' });
    return false;
  }
  return true;
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
        const [profile, rules] = await Promise.all([
          expertsRepository.findProfileById(expertProfileId),
          availabilityRulesRepository.listByExpertProfileId(expertProfileId),
        ]);

        if (!profile) {
          return reply.status(404).send({ error: 'Expert profile not found' });
        }

        return reply.send({
          timezone: profile.timezone,
          bookingSettings: {
            bufferBeforeMinutes: profile.bookingBufferBeforeMinutes,
            bufferAfterMinutes: profile.bookingBufferAfterMinutes,
            minimumNoticeMinutes: profile.bookingMinimumNoticeMinutes,
            windowDays: profile.bookingWindowDays,
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
      const { timezone, bookingSettings, rules } = body.data;

      try {
        if (!(await ensureProfileExists(expertProfileId, reply))) return reply;

        await db.transaction(async (tx) => {
          await expertsRepository.updateProfile(
            expertProfileId,
            {
              timezone,
              bookingBufferBeforeMinutes: bookingSettings.bufferBeforeMinutes,
              bookingBufferAfterMinutes: bookingSettings.bufferAfterMinutes,
              bookingMinimumNoticeMinutes: bookingSettings.minimumNoticeMinutes,
              bookingWindowDays: bookingSettings.windowDays,
            },
            tx
          );
          await availabilityRulesRepository.replaceForExpert(expertProfileId, rules, tx);
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

      const { expertProfileId } = params.data;

      try {
        if (!(await ensureProfileExists(expertProfileId, reply))) return reply;

        await availabilityRulesRepository.deleteAllForExpert(expertProfileId);
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
      const { timezone } = body.data;

      try {
        if (!(await ensureProfileExists(expertProfileId, reply))) return reply;

        await expertsRepository.updateProfile(expertProfileId, { timezone });
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
