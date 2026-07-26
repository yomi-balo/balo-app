import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { availabilityOverridesRepository, type AvailabilityOverride } from '@balo/db';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { enqueueAvailabilityCacheRebuild } from '../../jobs/availability-cache.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';

// ── Validation schemas ──────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const listQuerySchema = z.object({ expertProfileId: z.string().uuid() });

const createBodySchema = z
  .object({
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
  // String comparison is valid for zero-padded ISO dates.
  .refine((v) => v.endDate >= v.startDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  });

const deleteBodySchema = z.object({
  expertProfileId: z.string().uuid(),
  overrideId: z.string().uuid(),
});

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

/** Inclusive whole-day count of `[startIso, endIso]` (single day = 1). */
function inclusiveDayCount(startIso: string, endIso: string): number {
  const s = Date.parse(`${startIso}T00:00:00Z`);
  const e = Date.parse(`${endIso}T00:00:00Z`);
  return Math.round((e - s) / 86_400_000) + 1;
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

        trackServer(CALENDAR_SERVER_EVENTS.AVAILABILITY_OVERRIDE_CREATED, {
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

        trackServer(CALENDAR_SERVER_EVENTS.AVAILABILITY_OVERRIDE_DELETED, {
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
}
