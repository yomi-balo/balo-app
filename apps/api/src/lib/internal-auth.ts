import { timingSafeEqual } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Fastify preHandler that validates the internal API key.
 * Uses timing-safe comparison to prevent timing attacks.
 * Used for server-to-server calls (e.g. Next.js server actions calling Fastify).
 */
export async function requireInternalAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const expected = process.env.INTERNAL_API_SECRET;

  if (!expected) {
    request.log.error('INTERNAL_API_SECRET env var is not configured');
    return reply.status(500).send({ error: 'Server misconfiguration' });
  }

  const provided = request.headers['x-internal-api-key'] as string | undefined;

  if (!provided) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
