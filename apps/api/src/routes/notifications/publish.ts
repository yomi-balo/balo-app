import type { FastifyInstance } from 'fastify';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { notificationEvents } from '../../notifications/index.js';
import { publishBodySchema } from './schema.js';

export async function publishRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/notifications/publish',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = publishBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_payload',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const { event, payload } = parsed.data;

      await notificationEvents.publish(event, payload);

      return reply.send({ published: true });
    }
  );
}
