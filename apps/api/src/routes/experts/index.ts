import type { FastifyInstance } from 'fastify';
import { searchRoute } from './search.js';
import { scheduleRoutes } from './schedule.js';
import { availabilityOverridesRoutes } from './availability-overrides.js';
import { availabilityRoute } from './availability.js';

export async function expertsRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(searchRoute);
  await fastify.register(scheduleRoutes);
  await fastify.register(availabilityOverridesRoutes);
  await fastify.register(availabilityRoute);
}
