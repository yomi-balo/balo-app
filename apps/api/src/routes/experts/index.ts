import type { FastifyInstance } from 'fastify';
import { searchRoute } from './search.js';
import { scheduleRoutes } from './schedule.js';

export async function expertsRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(searchRoute);
  await fastify.register(scheduleRoutes);
}
