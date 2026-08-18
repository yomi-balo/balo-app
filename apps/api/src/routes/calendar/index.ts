import type { FastifyInstance } from 'fastify';
import { calendarAuthRoutes } from './auth.js';
import { calendarApiRoutes } from './api.js';
import { apirocWebhookPlugin } from './webhook.js';

export async function calendarRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(calendarAuthRoutes);
  await fastify.register(calendarApiRoutes);
  // BAL-468 — scoped plugin (raw-body capture + the route); see webhook.ts's docblock for why
  // it must be registered as its own child plugin rather than inline here.
  await fastify.register(apirocWebhookPlugin);
}
