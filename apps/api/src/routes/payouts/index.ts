import type { FastifyInstance } from 'fastify';
import { schemaRoute } from './schema.js';

export async function payoutsRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(schemaRoute);
}
