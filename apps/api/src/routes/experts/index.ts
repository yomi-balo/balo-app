import type { FastifyInstance } from 'fastify';
import { searchRoute } from './search.js';
import { availabilityOverridesRoutes } from './availability-overrides.js';

export async function expertsRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(searchRoute);
  await fastify.register(availabilityOverridesRoutes);
}
