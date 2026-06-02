import type { FastifyInstance } from 'fastify';
import { searchRoute } from './search.js';

export async function expertsRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(searchRoute);
}
