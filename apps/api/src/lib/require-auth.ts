import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '@balo/shared/logging';
import { usersRepository } from '@balo/db';
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
 *
 * ⚠⚠ `usersRepository` IS A STATIC ESM IMPORT AND MUST STAY ONE. It was `require('@balo/db')`
 * inline, which made EVERY `requireAuth`-gated route 401 in local dev while passing in
 * production and in CI — the worst possible asymmetry, and one no gate catches:
 *
 *   - `apps/api` is `"type": "module"`, and dev runs `tsx watch src/index.ts`, where `require`
 *     is simply not defined. The call threw a ReferenceError AFTER `jwtVerify` had already
 *     succeeded, so the catch below swallowed it as "JWT verification failed" → 401. A valid
 *     token could not pass.
 *   - Production never saw it: `tsup.config.ts` injects a `createRequire` banner into the
 *     bundle Railway runs, which defines `require`.
 *   - Unit tests never saw it either: vitest supplies its own CJS interop.
 *
 * Diagnosed from a `project_brief_parses` row stuck at `failure_reason: 'enqueue_failed'` —
 * the web action's reading of this route's 401. `no-bare-require.test.ts` now bans the shape.
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
