import type { FastifyInstance } from 'fastify';
import { calendarAuthRoutes } from './auth.js';
import { calendarApiRoutes } from './api.js';
import { calendarWebhookRoutes } from './webhook.js';

export async function calendarRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(calendarAuthRoutes);
  await fastify.register(calendarApiRoutes);
  await fastify.register(calendarWebhookRoutes);
}
