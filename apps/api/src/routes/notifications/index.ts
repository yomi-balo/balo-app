import type { FastifyInstance } from 'fastify';
import { publishRoute } from './publish.js';

export async function notificationsRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(publishRoute);
}
