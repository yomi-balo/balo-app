/**
 * BAL-239 dev-only seed endpoints.
 *
 * These routes are ONLY registered when NODE_ENV !== 'production' (see app.ts —
 * guarded dynamic import keeps faker + the seed service out of the prod bundle).
 * All three are protected by `requireInternalAuth` (server-action-to-Fastify).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { createLogger } from '@balo/shared/logging';
import {
  DEFAULT_EXPERT_COUNT,
  DEFAULT_SEED,
  MAX_EXPERT_COUNT,
} from '../../services/seed/constants.js';
import {
  regenerateExperts,
  refreshAvailability,
  fullReset,
} from '../../services/seed/seed-service.js';

const log = createLogger('dev-seed-routes');

const seedSchema = z.number().int().optional();
const countSchema = z.number().int().min(1).max(MAX_EXPERT_COUNT).optional();
const nowSchema = z.coerce.date().optional();

const expertsBodySchema = z.object({ count: countSchema, seed: seedSchema });
const availabilityBodySchema = z.object({ now: nowSchema, seed: seedSchema });
const resetBodySchema = z.object({ count: countSchema, now: nowSchema, seed: seedSchema });

export async function devSeedRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/dev/seed/experts',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = expertsBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i) => i.message),
        });
      }
      try {
        const summary = await regenerateExperts({
          count: parsed.data.count ?? DEFAULT_EXPERT_COUNT,
          seed: parsed.data.seed ?? DEFAULT_SEED,
        });
        return reply.send(summary);
      } catch (err: unknown) {
        log.error(
          {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Seed: regenerate experts failed'
        );
        return reply.status(500).send({ error: 'Failed to regenerate experts' });
      }
    }
  );

  fastify.post(
    '/dev/seed/availability',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = availabilityBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i) => i.message),
        });
      }
      try {
        const summary = await refreshAvailability({
          seed: parsed.data.seed ?? DEFAULT_SEED,
          baselineNow: parsed.data.now,
        });
        return reply.send(summary);
      } catch (err: unknown) {
        log.error(
          {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Seed: refresh availability failed'
        );
        return reply.status(500).send({ error: 'Failed to refresh availability' });
      }
    }
  );

  fastify.post('/dev/seed/reset', { preHandler: [requireInternalAuth] }, async (request, reply) => {
    const parsed = resetBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues.map((i) => i.message),
      });
    }
    try {
      const summary = await fullReset({
        count: parsed.data.count ?? DEFAULT_EXPERT_COUNT,
        seed: parsed.data.seed ?? DEFAULT_SEED,
        baselineNow: parsed.data.now,
      });
      return reply.send(summary);
    } catch (err: unknown) {
      log.error(
        {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'Seed: full reset failed'
      );
      return reply.status(500).send({ error: 'Failed to run full reset' });
    }
  });
}
