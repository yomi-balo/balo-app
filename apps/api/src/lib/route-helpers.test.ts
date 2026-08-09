import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseBodyOr400, resolveUserId } from './route-helpers.js';

/**
 * These two helpers were extracted from `routes/sessions` and `routes/meetings` by BAL-129.
 * Both routes exercise them end-to-end, but they are tested DIRECTLY here too: they are now
 * shared, so a change to either silently changes the auth fallback and the validation
 * response shape of every authed route at once.
 */

/** A reply stub that records the status and body it was sent. */
function replyStub(): FastifyReply & { sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      sent.status = status;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
    sent,
  };
  return reply as unknown as FastifyReply & { sent: typeof sent };
}

describe('resolveUserId', () => {
  it('returns the id when the preHandler populated it', () => {
    const reply = replyStub();
    const request = { userId: 'user_1' } as FastifyRequest;

    expect(resolveUserId(request, reply)).toBe('user_1');
    expect(reply.sent.status).toBeUndefined();
  });

  it('FAILS CLOSED with 401 when `request.userId` is unset', () => {
    // Reachable only if a route is registered without `requireAuth`. Reading `undefined` as
    // an actor instead would be an unauthenticated write.
    const reply = replyStub();

    expect(resolveUserId({} as FastifyRequest, reply)).toBeNull();
    expect(reply.sent.status).toBe(401);
    expect(reply.sent.body).toEqual({ error: 'Unauthorized' });
  });
});

describe('parseBodyOr400', () => {
  const schema = z.object({ name: z.string(), count: z.number().int() });

  it('returns the parsed data on a valid body', () => {
    const reply = replyStub();
    const request = { body: { name: 'a', count: 1 } } as FastifyRequest;

    expect(parseBodyOr400(schema, request, reply)).toEqual({ name: 'a', count: 1 });
    expect(reply.sent.status).toBeUndefined();
  });

  it('sends 400 invalid_request with Zod issue messages and returns null', () => {
    const reply = replyStub();
    const request = { body: { name: 1, count: 'x' } } as FastifyRequest;

    expect(parseBodyOr400(schema, request, reply)).toBeNull();
    expect(reply.sent.status).toBe(400);
    expect(reply.sent.body).toMatchObject({ error: 'invalid_request' });
    const body = reply.sent.body as { details: string[] };
    expect(body.details.length).toBeGreaterThan(0);
  });

  it('handles a missing body without throwing', () => {
    const reply = replyStub();

    expect(parseBodyOr400(schema, {} as FastifyRequest, reply)).toBeNull();
    expect(reply.sent.status).toBe(400);
  });

  it('echoes only Zod messages — never a caller-supplied value', () => {
    // The `details` echo is safe ONLY because Zod describes the SHAPE, not the content. If a
    // future Zod version started interpolating received values, this is what would catch it.
    const reply = replyStub();
    // Deliberately NOT a valid uuid — it has to actually fail for a 400 to be sent at all.
    const secret = 'sk_live_super_secret_value';
    const uuidSchema = z.object({ id: z.string().uuid() });

    parseBodyOr400(uuidSchema, { body: { id: secret } } as FastifyRequest, reply);

    expect(reply.sent.status).toBe(400);
    expect(JSON.stringify(reply.sent.body)).not.toContain(secret);
  });

  it('does not call the reply at all on success', () => {
    const code = vi.fn();
    const reply = { code } as unknown as FastifyReply;

    parseBodyOr400(schema, { body: { name: 'a', count: 2 } } as FastifyRequest, reply);

    expect(code).not.toHaveBeenCalled();
  });
});
