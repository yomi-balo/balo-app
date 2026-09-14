import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const { mockJwtVerify, mockCreateRemoteJWKSet, mockFindByWorkosId } = vi.hoisted(() => ({
  mockJwtVerify: vi.fn(),
  mockCreateRemoteJWKSet: vi.fn(() => 'jwks-instance'),
  mockFindByWorkosId: vi.fn(),
}));

vi.mock('jose', () => ({
  jwtVerify: mockJwtVerify,
  createRemoteJWKSet: mockCreateRemoteJWKSet,
}));

/**
 * ⚠ `usersRepository` MUST stay in this factory. `requireAuth` reaches it through a STATIC ESM
 * import; if the module shape drifts, the assertions below die on a TypeError instead of
 * failing — and a proof that dies on a TypeError proves nothing about the behaviour.
 */
vi.mock('@balo/db', () => ({
  usersRepository: { findByWorkosId: mockFindByWorkosId },
}));

import { requireAuth } from './require-auth.js';

function makeReplyAndRequest(authorization?: string) {
  const send = vi.fn();
  const reply = { status: vi.fn(() => ({ send })), send } as unknown as FastifyReply;
  const request = {
    headers: authorization === undefined ? {} : { authorization },
  } as FastifyRequest;
  return { request, reply, send };
}

describe('requireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['WORKOS_CLIENT_ID'] = 'client_123';
    mockCreateRemoteJWKSet.mockReturnValue('jwks-instance');
  });

  /**
   * ⚠⚠ THE REGRESSION THIS FILE EXISTS FOR. `requireAuth` resolved the Balo user with
   * `require('@balo/db')` — a CJS call in an ESM module. Under `tsx` (how `pnpm dev` runs the
   * api) `require` is UNDEFINED, so it threw `ReferenceError: require is not defined` AFTER
   * `jwtVerify` had already succeeded; the catch turned that into "JWT verification failed" and
   * replied 401. EVERY `requireAuth`-gated route was unreachable in local dev while tsup
   * (production, via a `createRequire` banner) and vitest both stayed green.
   *
   * ⚠ THIS TEST FAILS ON THE OLD CODE, BUT NOT FOR THE DEV REASON — mechanism verified, not
   * assumed. Vitest DOES define `require`, so there is no ReferenceError here; instead the CJS
   * call resolves the REAL `@balo/db` and bypasses the `vi.mock` above, so the repository double
   * is never called and this assertion fails on `findByWorkosId`. Two different causes, one red
   * test. The dev-only shape itself is banned structurally by
   * `src/invariants/no-bare-require.test.ts`, which is the pin that reasons about `tsx`.
   */
  it('⚠ resolves a valid token to the Balo user id and does not reply', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_user_1' } });
    mockFindByWorkosId.mockResolvedValue({ id: 'balo-user-1' });
    const { request, reply, send } = makeReplyAndRequest('Bearer good-token');

    await requireAuth(request, reply);

    expect(mockJwtVerify).toHaveBeenCalledWith('good-token', 'jwks-instance');
    expect(mockFindByWorkosId).toHaveBeenCalledWith('workos_user_1');
    expect(request.userId).toBe('balo-user-1');
    // Nothing was refused.
    expect(reply.status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('401s with no Authorization header', async () => {
    const { request, reply } = makeReplyAndRequest();

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(mockJwtVerify).not.toHaveBeenCalled();
    expect(request.userId).toBeUndefined();
  });

  it('401s on a non-Bearer scheme without touching the JWKS', async () => {
    const { request, reply } = makeReplyAndRequest('Basic abc123');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it('401s when the token carries no `sub` claim', async () => {
    mockJwtVerify.mockResolvedValue({ payload: {} });
    const { request, reply } = makeReplyAndRequest('Bearer no-sub');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(mockFindByWorkosId).not.toHaveBeenCalled();
    expect(request.userId).toBeUndefined();
  });

  it('401s when the WorkOS identity maps to no Balo user', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_ghost' } });
    mockFindByWorkosId.mockResolvedValue(undefined);
    const { request, reply } = makeReplyAndRequest('Bearer orphan');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(request.userId).toBeUndefined();
  });

  it('401s when verification throws (expired / wrong signature)', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));
    const { request, reply } = makeReplyAndRequest('Bearer bad');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(request.userId).toBeUndefined();
  });

  /**
   * ⚠ A repository throw is NOT an authentication outcome, but the catch swallows it into the
   * same 401 — which is exactly what disguised the `require` ReferenceError. Pinned so the
   * behaviour is a recorded decision rather than an accident; a future change that lets
   * infrastructure failures surface as 500 should update this test deliberately.
   */
  it('⚠ a repository failure is swallowed into a 401, not surfaced', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_user_1' } });
    mockFindByWorkosId.mockRejectedValue(new Error('connection terminated'));
    const { request, reply } = makeReplyAndRequest('Bearer good-token');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(request.userId).toBeUndefined();
  });
});
