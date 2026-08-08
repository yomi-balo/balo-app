import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/**
 * Shared Fastify controller helpers (extracted by BAL-129).
 *
 * ⚠ EXTRACTED, NOT INVENTED. `resolveUserId` was byte-identical in
 * `routes/sessions/index.ts` and BAL-129's `routes/meetings/index.ts`, which is precisely
 * the cross-file duplication SonarCloud's gate flags — and, more importantly, two places to
 * get an AUTH fallback subtly wrong. One definition means the defensive 401 behaves the same
 * on every authed route.
 */

/**
 * Resolve the authenticated user id, or send `401` and return `null`.
 *
 * ⚠ DEFENSIVE, NOT THE GATE. `requireAuth` (the preHandler) is what actually authenticates
 * and is what populates `request.userId`; by the time a handler body runs, an unauthenticated
 * request has already been answered. This exists so that a route accidentally registered
 * WITHOUT the preHandler fails closed with a 401 instead of reading `undefined` as an actor.
 * Every caller must `return` immediately on `null` — the reply has already been sent.
 */
export function resolveUserId(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = request.userId;
  if (userId === undefined) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return userId;
}

/**
 * Zod-validate `request.body`, or send the house `400 invalid_request` and return `null`.
 *
 * ⚠ ECHOING `issue.message` IS SAFE AND IS THE HOUSE STYLE — but ONLY for Zod issues. Zod
 * messages describe the SHAPE the caller sent ("Invalid uuid", "Required"); they never carry
 * a server-side row id. That is the opposite of the typed repository errors, which embed raw
 * uuids to make the SERVER log actionable and must be mapped to fixed literals instead. Do
 * not reuse this helper's `details` pattern for anything but a Zod parse failure.
 *
 * Callers must `return` immediately on `null` — the reply has already been sent. The schemas
 * here are all objects, so a `null` return is unambiguously "rejected", never valid data.
 */
export function parseBodyOr400<Schema extends z.ZodType>(
  schema: Schema,
  request: FastifyRequest,
  reply: FastifyReply
): z.infer<Schema> | null {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400).send({
      error: 'invalid_request',
      details: parsed.error.issues.map((issue) => issue.message),
    });
    return null;
  }
  return parsed.data;
}
