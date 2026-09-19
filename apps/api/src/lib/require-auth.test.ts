import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const {
  mockJwtVerify,
  mockCreateRemoteJWKSet,
  mockFindByWorkosId,
  mockTrackServer,
  mockWarn,
  mockError,
} = vi.hoisted(() => ({
  mockJwtVerify: vi.fn(),
  mockCreateRemoteJWKSet: vi.fn(() => 'jwks-instance'),
  mockFindByWorkosId: vi.fn(),
  mockTrackServer: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('jose', () => ({
  jwtVerify: mockJwtVerify,
  createRemoteJWKSet: mockCreateRemoteJWKSet,
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: mockWarn, error: mockError, info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  AUTH_SERVER_EVENTS: { SESSION_INVALIDATED: 'auth_session_invalidated' },
}));

/**
 * ⚠ `usersRepository` MUST stay in this factory. `requireAuth` reaches it through a STATIC ESM
 * import; if the module shape drifts, the assertions below die on a TypeError instead of
 * failing — and a proof that dies on a TypeError proves nothing about the behaviour.
 */
vi.mock('@balo/db', () => ({
  usersRepository: {
    // ⚠ THE ONLY REPOSITORY MEMBER `requireAuth` MAY REACH FOR. Fix round 1 (F5) removed the
    // soft-deleted fallback; deliberately leaving this factory with a single member means a
    // re-added second read fails loudly here (undefined is not a function) rather than quietly
    // resolving the real `@balo/db`.
    findByWorkosId: mockFindByWorkosId,
  },
}));

import { ACCOUNT_REFUSAL_HEADER } from '@balo/shared/authz';
import { requireAuth } from './require-auth.js';

/**
 * ⚠ THE REPLY DOUBLE MODELS FASTIFY'S CHAIN, `status().header().send()` INCLUDED. BAL-568's
 * account arm replies `reply.status(401).header(…).send(…)`; a double whose `status()` returned
 * only `{ send }` would throw a TypeError there and the test would die rather than fail.
 */
function makeReplyAndRequest(authorization?: string) {
  const send = vi.fn();
  const header = vi.fn(() => ({ send }));
  const reply = {
    status: vi.fn(() => ({ send, header })),
    send,
    header,
  } as unknown as FastifyReply;
  const request = {
    headers: authorization === undefined ? {} : { authorization },
  } as FastifyRequest;
  return { request, reply, send, header };
}

/** Every message the logger was called with, in order — for the "which arm logged it" pins. */
const warnMessages = (): string[] => mockWarn.mock.calls.map((call) => String(call[1]));
const errorMessages = (): string[] => mockError.mock.calls.map((call) => String(call[1]));

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
    mockFindByWorkosId.mockResolvedValue({ id: 'balo-user-1', status: 'active', deletedAt: null });
    const { request, reply, send, header } = makeReplyAndRequest('Bearer good-token');

    await requireAuth(request, reply);

    expect(mockJwtVerify).toHaveBeenCalledWith('good-token', 'jwks-instance');
    expect(mockFindByWorkosId).toHaveBeenCalledWith('workos_user_1');
    expect(request.userId).toBe('balo-user-1');
    // Nothing was refused.
    expect(reply.status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(header).not.toHaveBeenCalled();
    // ⚠ BAL-568 — EVERY PATH COSTS EXACTLY ONE QUERY, byte-identical to before the ticket. Fix
    // round 1 (F5) removed the soft-deleted fallback precisely because a second, unindexed read
    // here sat ahead of every rate limiter.
    expect(mockFindByWorkosId).toHaveBeenCalledTimes(1);
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
   * ⚠ A repository throw is NOT an authentication outcome, but it is still swallowed into a 401.
   * Pinned so the behaviour is a recorded decision rather than an accident; a future change that
   * lets infrastructure failures surface as 500 should update this test deliberately.
   *
   * ⚠ BAL-568 CHANGED THE MESSAGE, NOT THE STATUS. The read now sits on its OWN arm outside the
   * `jwtVerify` catch, so it logs `'Account liveness read failed — refusing'` instead of being
   * mislabelled `'JWT verification failed'` — which is exactly what disguised the `require`
   * ReferenceError for months. See the dedicated assertion below.
   */
  it('⚠ a repository failure is swallowed into a 401, not surfaced', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_user_1' } });
    mockFindByWorkosId.mockRejectedValue(new Error('connection terminated'));
    const { request, reply } = makeReplyAndRequest('Bearer good-token');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(request.userId).toBeUndefined();
  });

  // ── BAL-568 — account liveness on every authenticated API call ───────────────────────────

  it('⚠ refuses a SUSPENDED live row: 401 + the marker header, on ONE query', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_user_1' } });
    mockFindByWorkosId.mockResolvedValue({
      id: 'balo-user-1',
      status: 'suspended',
      deletedAt: null,
    });
    const { request, reply, send, header } = makeReplyAndRequest('Bearer good-token');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(header).toHaveBeenCalledWith(ACCOUNT_REFUSAL_HEADER, 'account_suspended');
    expect(send).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(request.userId).toBeUndefined();
    // ⚠ EXACTLY ONE READ, ALWAYS (fix round 1, F5) — this is the authentication hot path, ahead of
    // every rate limiter, and a second unindexed read here was a seq-scan an attacker could drive.
    expect(mockFindByWorkosId).toHaveBeenCalledTimes(1);
    expect(warnMessages()).toContain('Account not live — refusing API call');
    expect(mockTrackServer).toHaveBeenCalledWith('auth_session_invalidated', {
      distinct_id: 'balo-user-1',
      path: 'api',
      reason: 'suspended',
    });
  });

  /**
   * ⚠⚠ THE API PATH CANNOT EMIT `account_deleted`, AND THAT IS A DELIBERATE DESIGN OUTCOME (fix
   * round 1, F5), not a gap. `findByWorkosId` filters `deleted_at IS NULL`, so a soft-deleted
   * account is indistinguishable from an unknown `sub` here. Telling them apart required a
   * `deleted_at IS NOT NULL` lookup, which cannot use the PARTIAL `users_workos_id_unique` and so
   * seq-scanned `users` — on the hot path, ahead of the rate limiter. The account is still fully
   * REFUSED; only the teardown marker is absent, so the web side does not proactively sign it out.
   *
   * This test exists so nobody "restores" the second read to make a missing marker go away.
   */
  it('⚠ a SOFT-DELETED sub gets the UNMARKED 401 — the api never emits account_deleted', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_gone' } });
    // What a soft-deleted account actually looks like to this route: `findByWorkosId` filters it
    // out, so the route sees exactly what it sees for an unknown identity.
    mockFindByWorkosId.mockResolvedValue(undefined);
    const { request, reply, send, header } = makeReplyAndRequest('Bearer deleted');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(header).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    expect(request.userId).toBeUndefined();
    expect(mockFindByWorkosId).toHaveBeenCalledTimes(1);
  });

  it('⚠ an UNKNOWN sub gets NO marker — nothing about a third party is enumerable', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_ghost' } });
    mockFindByWorkosId.mockResolvedValue(undefined);
    const { request, reply, header } = makeReplyAndRequest('Bearer orphan');

    await requireAuth(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(header).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    // The shipped line, byte-identical.
    expect(warnMessages()).toContain('No Balo user found for WorkOS ID');
  });

  /**
   * ⚠⚠ THE BODY IS BYTE-IDENTICAL ON BOTH ARMS. This is what reconciles the ticket's
   * "byte-identical 401" with the ruling's "explicit, non-guessable marker": the marker lives on
   * a HEADER, and the JSON an unauthenticated prober can see is the same object either way.
   */
  it('⚠ the 401 BODY of a suspended refusal equals the unknown-user 401 body exactly', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_ghost' } });
    mockFindByWorkosId.mockResolvedValue(undefined);
    const unknown = makeReplyAndRequest('Bearer orphan');
    await requireAuth(unknown.request, unknown.reply);
    const unknownBody: unknown = unknown.send.mock.calls[0]?.[0];

    vi.clearAllMocks();
    mockCreateRemoteJWKSet.mockReturnValue('jwks-instance');
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_user_1' } });
    mockFindByWorkosId.mockResolvedValue({
      id: 'balo-user-1',
      status: 'suspended',
      deletedAt: null,
    });
    const suspended = makeReplyAndRequest('Bearer good-token');
    await requireAuth(suspended.request, suspended.reply);
    const suspendedBody: unknown = suspended.send.mock.calls[0]?.[0];

    expect(unknownBody).toEqual({ error: 'Unauthorized' });
    expect(suspendedBody).toEqual(unknownBody);
  });

  /**
   * ⚠⚠ THE ASSERTION THAT PROVES THE RESTRUCTURE ACTUALLY HAPPENED. The ticket requires the
   * account arm to sit on its own arm OUTSIDE the `jwtVerify` catch. Without this, moving the
   * read back inside that catch would leave every other test green while re-creating the exact
   * mislabelling that hid the `require` ReferenceError.
   */
  it('⚠ a DB fault logs its OWN message, never "JWT verification failed", and carries NO marker', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'workos_user_1' } });
    mockFindByWorkosId.mockRejectedValue(new Error('connection terminated'));
    const { request, reply, send, header } = makeReplyAndRequest('Bearer good-token');

    await requireAuth(request, reply);

    expect(errorMessages()).toContain('Account liveness read failed — refusing');
    expect(warnMessages()).not.toContain('JWT verification failed');
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith({ error: 'Unauthorized' });
    // ⚠ FAIL CLOSED ON ACCESS, FAIL OPEN ON TEARDOWN: it refuses, but it must NOT claim the
    // account is suspended. A database blip that signed every user out with "your account has
    // been suspended" would be a mass-logout incident and a lie.
    expect(header).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('⚠ a bad signature still logs "JWT verification failed" and carries NO marker', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));
    const { request, reply, header } = makeReplyAndRequest('Bearer bad');

    await requireAuth(request, reply);

    expect(warnMessages()).toContain('JWT verification failed');
    expect(errorMessages()).not.toContain('Account liveness read failed — refusing');
    expect(header).not.toHaveBeenCalled();
    expect(mockFindByWorkosId).not.toHaveBeenCalled();
  });
});
