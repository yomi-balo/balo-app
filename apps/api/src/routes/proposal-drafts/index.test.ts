import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { DRAFT_DEADLINE_MS } from '@balo/shared/project-requests';

const { findForRelationshipExpert, enqueueProposalDraftGenerate, mockError, auth, limiter } =
  vi.hoisted(() => ({
    findForRelationshipExpert: vi.fn(),
    enqueueProposalDraftGenerate: vi.fn(),
    mockError: vi.fn(),
    /** Each test picks the auth arm it means; the mock delegates to this mutable behaviour. */
    auth: { mode: 'authenticated' as 'authenticated' | 'unauthenticated' | 'silently-absent' },
    /** `capture` records the limiter config; `block` makes the limiter answer 429. */
    limiter: { config: undefined as unknown, block: false },
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockError }),
}));
vi.mock('@balo/db', () => ({
  proposalDraftGenerationsRepository: { findForRelationshipExpert },
}));
vi.mock('../../lib/require-auth.js', () => ({
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
// Built once at import time. The stub records its config and, when `block` is set, answers 429
// the way the real limiter does, so the Redis cap is observable without Redis.
vi.mock('../../lib/rate-limit-prehandler.js', () => ({
  createRateLimitPreHandler: (options: unknown) => {
    limiter.config = options;
    return async (
      _request: unknown,
      reply: { code: (n: number) => { send: (body: unknown) => void } }
    ) => {
      if (limiter.block) reply.code(429).send({ error: 'Too Many Requests' });
    };
  },
}));
vi.mock('../../jobs/proposal-draft-generate.js', () => ({
  enqueueProposalDraftGenerate,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { proposalDraftRoutes } from './index.js';

const GENERATION_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_URL = '/proposal-drafts/generate';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const pendingRow = { id: GENERATION_ID, status: 'pending', createdAt: CREATED_AT };

describe('POST /proposal-drafts/generate', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(proposalDraftRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CREATED_AT.getTime() + 5_000);
    auth.mode = 'authenticated';
    limiter.block = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const post = (payload: object) => app.inject({ method: 'POST', url: ROUTE_URL, payload });

  it('401s without a valid bearer, and never reaches the row lookup or the queue', async () => {
    auth.mode = 'unauthenticated';
    const res = await post({ generationId: GENERATION_ID });
    expect(res.statusCode).toBe(401);
    expect(findForRelationshipExpert).not.toHaveBeenCalled();
    expect(enqueueProposalDraftGenerate).not.toHaveBeenCalled();
  });

  it('401s defensively if the preHandler never populated userId', async () => {
    auth.mode = 'silently-absent';
    const res = await post({ generationId: GENERATION_ID });
    expect(res.statusCode).toBe(401);
    expect(findForRelationshipExpert).not.toHaveBeenCalled();
    expect(enqueueProposalDraftGenerate).not.toHaveBeenCalled();
  });

  it('429s when the Redis limiter blocks, without a lookup or an enqueue', async () => {
    limiter.block = true;
    const res = await post({ generationId: GENERATION_ID });
    expect(res.statusCode).toBe(429);
    expect(findForRelationshipExpert).not.toHaveBeenCalled();
    expect(enqueueProposalDraftGenerate).not.toHaveBeenCalled();
  });

  it('configures the limiter at the hourly cap, fail-closed', () => {
    expect(limiter.config).toMatchObject({
      config: { keyPrefix: 'proposal-draft', maxRequests: 20, windowSeconds: 3600 },
      failOpen: false,
    });
  });

  it('400s on a non-uuid generationId', async () => {
    const res = await post({ generationId: 'not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(enqueueProposalDraftGenerate).not.toHaveBeenCalled();
  });

  it("404s when the generation isn't the caller's, scoping the lookup to the bearer's user", async () => {
    findForRelationshipExpert.mockResolvedValue(undefined);
    const res = await post({ generationId: GENERATION_ID });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(findForRelationshipExpert).toHaveBeenCalledWith({
      generationId: GENERATION_ID,
      userId: 'user_1',
    });
    expect(enqueueProposalDraftGenerate).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'failed'])('409s when the generation is already %s', async (status) => {
    findForRelationshipExpert.mockResolvedValue({ ...pendingRow, status });
    const res = await post({ generationId: GENERATION_ID });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_completed' });
    expect(enqueueProposalDraftGenerate).not.toHaveBeenCalled();
  });

  it('409s when a pending generation is past the draft deadline, without enqueueing', async () => {
    findForRelationshipExpert.mockResolvedValue(pendingRow);
    vi.setSystemTime(CREATED_AT.getTime() + DRAFT_DEADLINE_MS + 1);
    const res = await post({ generationId: GENERATION_ID });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_completed' });
    expect(enqueueProposalDraftGenerate).not.toHaveBeenCalled();
  });

  it('still enqueues a pending generation exactly at the deadline', async () => {
    findForRelationshipExpert.mockResolvedValue(pendingRow);
    enqueueProposalDraftGenerate.mockResolvedValue(undefined);
    vi.setSystemTime(CREATED_AT.getTime() + DRAFT_DEADLINE_MS);
    const res = await post({ generationId: GENERATION_ID });
    expect(res.statusCode).toBe(202);
  });

  it('202s on the happy path and enqueues the generation', async () => {
    findForRelationshipExpert.mockResolvedValue(pendingRow);
    enqueueProposalDraftGenerate.mockResolvedValue(undefined);

    const res = await post({ generationId: GENERATION_ID });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ enqueued: true });
    expect(enqueueProposalDraftGenerate).toHaveBeenCalledWith({ generationId: GENERATION_ID });
  });

  it('503s when the enqueue throws, logging the error', async () => {
    findForRelationshipExpert.mockResolvedValue(pendingRow);
    enqueueProposalDraftGenerate.mockRejectedValue(new Error('redis down'));

    const res = await post({ generationId: GENERATION_ID });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'enqueue_failed' });
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: GENERATION_ID, userId: 'user_1' }),
      'Failed to enqueue proposal draft generation'
    );
  });
});
