import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const {
  mockOpenSession,
  mockConnectSession,
  mockEndSession,
  mockGetDrawdownState,
  mockNudge,
  SessionNotFoundError,
  InvalidSessionTransitionError,
} = vi.hoisted(() => {
  class SessionNotFoundError extends Error {
    constructor() {
      super('not found');
      this.name = 'SessionNotFoundError';
    }
  }
  class InvalidSessionTransitionError extends Error {
    constructor() {
      super('invalid');
      this.name = 'InvalidSessionTransitionError';
    }
  }
  return {
    mockOpenSession: vi.fn(),
    mockConnectSession: vi.fn(),
    mockEndSession: vi.fn(),
    mockGetDrawdownState: vi.fn(),
    mockNudge: vi.fn(),
    SessionNotFoundError,
    InvalidSessionTransitionError,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({ SessionNotFoundError, InvalidSessionTransitionError }));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = 'user_1';
  },
}));
vi.mock('../../services/credit-session/index.js', () => ({
  openSession: mockOpenSession,
  connectSession: mockConnectSession,
  endSession: mockEndSession,
  getSessionDrawdownState: mockGetDrawdownState,
  nudgeAdminForTopup: mockNudge,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { sessionsRoutes } from './index.js';

const EXPERT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const DRAWDOWN = { key: 'healthy', lens: 'client' };

describe('sessions routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sessionsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /sessions', () => {
    it('201s with the pending session on success', async () => {
      mockOpenSession.mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        status: 'pending',
        holdId: 'hold_1',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ sessionId: SESSION_ID, status: 'pending', holdId: 'hold_1' });
      expect(mockOpenSession).toHaveBeenCalledWith({
        initiatingMemberId: 'user_1',
        expertProfileId: EXPERT_ID,
        estimatedMinutes: 30,
      });
    });

    it('400s on an invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { estimatedMinutes: 0 },
      });
      expect(res.statusCode).toBe(400);
      expect(mockOpenSession).not.toHaveBeenCalled();
    });

    it('403s on the forbidden capability gate', async () => {
      mockOpenSession.mockResolvedValue({ ok: false, code: 'forbidden' });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: 'forbidden' });
    });

    it('409s on a money gate rejection', async () => {
      mockOpenSession.mockResolvedValue({ ok: false, code: 'insufficient_no_mandate' });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'insufficient_no_mandate' });
    });

    it('409s when a session is already in progress on the wallet', async () => {
      mockOpenSession.mockResolvedValue({ ok: false, code: 'session_in_progress' });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'session_in_progress' });
    });

    it('409s when a prior session settlement is still pending (balance < 0)', async () => {
      mockOpenSession.mockResolvedValue({ ok: false, code: 'settlement_pending' });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'settlement_pending' });
    });
  });

  describe('POST /sessions/:id/connect', () => {
    it('200s the fresh DrawdownState on success', async () => {
      mockConnectSession.mockResolvedValue({
        ok: true,
        session: { id: SESSION_ID, status: 'active' },
      });
      mockGetDrawdownState.mockResolvedValue(DRAWDOWN);
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/connect` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(DRAWDOWN);
      expect(mockConnectSession).toHaveBeenCalledWith(SESSION_ID, 'user_1');
    });

    it('404s when the actor authorization reports not_found', async () => {
      mockConnectSession.mockResolvedValue({ ok: false, code: 'not_found' });
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/connect` });
      expect(res.statusCode).toBe(404);
    });

    it('403s when the actor is not a member of the session company (cross-tenant IDOR)', async () => {
      mockConnectSession.mockResolvedValue({ ok: false, code: 'forbidden' });
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/connect` });
      expect(res.statusCode).toBe(403);
    });

    it('409s on an illegal transition', async () => {
      mockConnectSession.mockRejectedValue(new InvalidSessionTransitionError());
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/connect` });
      expect(res.statusCode).toBe(409);
    });

    it('400s on an invalid session id', async () => {
      const res = await app.inject({ method: 'POST', url: '/sessions/not-a-uuid/connect' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /sessions/:id/end', () => {
    it('200s the settlement summary with no raw expertAccruedMinor in the body', async () => {
      const result = { settlementStatus: 'processing', overdraftSettledMinor: 1200 };
      mockEndSession.mockResolvedValue({ ok: true, result });
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/end` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(result);
      expect(res.json()).not.toHaveProperty('expertAccruedMinor');
      expect(mockEndSession).toHaveBeenCalledWith(SESSION_ID, 'user_1');
    });

    it('403s when the actor is not a member of the session company (cross-tenant IDOR)', async () => {
      mockEndSession.mockResolvedValue({ ok: false, code: 'forbidden' });
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/end` });
      expect(res.statusCode).toBe(403);
    });

    it('404s when the actor authorization reports not_found', async () => {
      mockEndSession.mockResolvedValue({ ok: false, code: 'not_found' });
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/end` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /sessions/:id/nudge', () => {
    it('202s ok', async () => {
      mockNudge.mockResolvedValue({ ok: true });
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/nudge` });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
      expect(mockNudge).toHaveBeenCalledWith(SESSION_ID, 'user_1');
    });

    it('404s when the session is gone', async () => {
      mockNudge.mockResolvedValue({ ok: false, code: 'not_found' });
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/nudge` });
      expect(res.statusCode).toBe(404);
    });

    it('403s when the actor is not a member (cross-tenant nudge spam)', async () => {
      mockNudge.mockResolvedValue({ ok: false, code: 'forbidden' });
      const res = await app.inject({ method: 'POST', url: `/sessions/${SESSION_ID}/nudge` });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /sessions/:id/drawdown-state', () => {
    it('200s the DrawdownState', async () => {
      mockGetDrawdownState.mockResolvedValue(DRAWDOWN);
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${SESSION_ID}/drawdown-state`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(DRAWDOWN);
    });

    it('404s when the session is not found', async () => {
      mockGetDrawdownState.mockResolvedValue(undefined);
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${SESSION_ID}/drawdown-state`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
