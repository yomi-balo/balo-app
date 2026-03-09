import type { FastifyInstance } from 'fastify';
import { schemaRoute } from './schema.js';
import { beneficiaryRoute } from './beneficiary.js';

export async function payoutsRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(schemaRoute);
  await fastify.register(beneficiaryRoute);
}
