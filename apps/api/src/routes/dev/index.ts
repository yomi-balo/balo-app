import type { FastifyInstance } from 'fastify';
import { devSeedRoutes } from './seed.js';

/**
 * Dev-only route group (BAL-239). Registered exclusively when
 * NODE_ENV !== 'production' via a guarded dynamic import in app.ts.
 */
export async function devRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(devSeedRoutes);
}
