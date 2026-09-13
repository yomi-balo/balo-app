import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { findForRequester, enqueueProjectBriefParse, mockError, auth } = vi.hoisted(() => ({
  findForRequester: vi.fn(),
  enqueueProjectBriefParse: vi.fn(),
  mockError: vi.fn(),
  /**
   * ⚠ THE AUTH SWITCH (fix round F12). `requireAuth` has to be mocked — the real one fetches a
   * WorkOS JWKS over the network — but a mock hard-wired to "always authenticated" makes the
   * 401 arm of this route UNTESTABLE, which is exactly what the review found. So the mock
   * DELEGATES to this mutable behaviour, and each test picks the arm it means.
   */
  auth: { mode: 'authenticated' as 'authenticated' | 'unauthenticated' | 'silently-absent' },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockError }),
}));
vi.mock('@balo/db', () => ({
  projectBriefParsesRepository: { findForRequester },
}));
vi.mock('../../lib/require-auth.js', () => ({
  /**
   * Reproduces the REAL `requireAuth`'s two observable behaviours (`lib/require-auth.ts`):
   *  · a valid bearer populates `request.userId` and returns;
   *  · anything else `reply.status(401).send({ error: 'Unauthorized' })` and returns — which
   *    short-circuits the preHandler chain, so the handler body never runs.
   * `silently-absent` is neither: it models a route accidentally registered WITHOUT the
   * preHandler, which is the case `resolveUserId`'s defensive 401 exists for.
   */
  requireAuth: async (
    request: { userId?: string },
    reply: { status: (code: number) => { send: (body: unknown) => void } }
  ) => {
    if (auth.mode === 'authenticated') {
      request.userId = 'user_1';
      return;
    }
    if (auth.mode === 'unauthenticated') {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  },
}));
// The rate limiter is module-scope-constructed (built once at import time) — stub it to a
// pass-through so this suite exercises the ROUTE, not Redis.
vi.mock('../../lib/rate-limit-prehandler.js', () => ({
  createRateLimitPreHandler: () => async () => false,
}));
vi.mock('../../jobs/project-brief-parse.js', () => ({
  enqueueProjectBriefParse,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { projectBriefRoutes } from './index.js';

const PARSE_ID = '11111111-1111-4111-8111-111111111111';

describe('POST /project-briefs/parse', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(projectBriefRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    auth.mode = 'authenticated';
  });

  // ── The negative-auth arm (fix round F12) ─────────────────────────────────────────────────
  it('401s without a valid bearer, and never reaches the row lookup or the queue', async () => {
    auth.mode = 'unauthenticated';
    const res = await app.inject({
      method: 'POST',
      url: '/project-briefs/parse',
      payload: { parseId: PARSE_ID },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    expect(findForRequester).not.toHaveBeenCalled();
    expect(enqueueProjectBriefParse).not.toHaveBeenCalled();
  });

  it('401s (defensively) if the preHandler never populated userId — resolveUserId fails closed', async () => {
    auth.mode = 'silently-absent';
    const res = await app.inject({
      method: 'POST',
      url: '/project-briefs/parse',
      payload: { parseId: PARSE_ID },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    expect(findForRequester).not.toHaveBeenCalled();
    expect(enqueueProjectBriefParse).not.toHaveBeenCalled();
  });

  it('400s on a non-uuid parseId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/project-briefs/parse',
      payload: { parseId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    expect(enqueueProjectBriefParse).not.toHaveBeenCalled();
  });

  it("404s when the row isn't the requester's (D9 — the API's own ownership check)", async () => {
    findForRequester.mockResolvedValue(undefined);
    const res = await app.inject({
      method: 'POST',
      url: '/project-briefs/parse',
      payload: { parseId: PARSE_ID },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(enqueueProjectBriefParse).not.toHaveBeenCalled();
  });

  it('409s when the row is already completed', async () => {
    findForRequester.mockResolvedValue({ id: PARSE_ID, completedAt: new Date() });
    const res = await app.inject({
      method: 'POST',
      url: '/project-briefs/parse',
      payload: { parseId: PARSE_ID },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_completed' });
  });

  it('202s on the happy path, with enqueueProjectBriefParse asserted', async () => {
    findForRequester.mockResolvedValue({ id: PARSE_ID, completedAt: null });
    enqueueProjectBriefParse.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/project-briefs/parse',
      payload: { parseId: PARSE_ID },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ enqueued: true });
    expect(enqueueProjectBriefParse).toHaveBeenCalledWith({ parseId: PARSE_ID });
  });

  it('503s when the enqueue throws, logging the error', async () => {
    findForRequester.mockResolvedValue({ id: PARSE_ID, completedAt: null });
    enqueueProjectBriefParse.mockRejectedValue(new Error('redis down'));

    const res = await app.inject({
      method: 'POST',
      url: '/project-briefs/parse',
      payload: { parseId: PARSE_ID },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'enqueue_failed' });
    expect(mockError).toHaveBeenCalled();
  });
});
