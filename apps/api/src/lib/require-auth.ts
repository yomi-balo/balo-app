import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '@balo/shared/logging';
import type { FastifyRequest, FastifyReply } from 'fastify';

const log = createLogger('require-auth');

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by requireAuth preHandler — Balo user UUID. */
    userId?: string;
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks) return jwks;

  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!clientId) {
    throw new Error('WORKOS_CLIENT_ID is not configured');
  }

  jwks = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`));
  return jwks;
}

/**
 * Fastify preHandler that validates a WorkOS Bearer token.
 * Resolves the WorkOS `sub` claim to a Balo user UUID and populates `request.userId`.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const token = header.slice(7);

  try {
    const { payload } = await jwtVerify(token, getJwks());
    const sub = payload.sub;
    if (!sub) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { usersRepository } = require('@balo/db');
    const user = await usersRepository.findByWorkosId(sub);
    if (!user) {
      log.warn({ workosId: sub }, 'No Balo user found for WorkOS ID');
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    request.userId = user.id;
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'JWT verification failed'
    );
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
