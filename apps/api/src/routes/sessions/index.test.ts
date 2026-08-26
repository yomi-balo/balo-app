import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const {
  mockOpenSession,
  mockConnectSession,
  mockEndSession,
  mockGetDrawdownState,
  mockNudge,
  mockResolveMoneyBlock,
  mockResolveAdminMoneyBlock,
  mockFinalizeExternalDuration,
  mockUsersFindById,
  SessionNotFoundError,
  InvalidSessionTransitionError,
  ExternalDurationConflictError,
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
  class ExternalDurationConflictError extends Error {
    constructor() {
      super('conflict');
      this.name = 'ExternalDurationConflictError';
    }
  }
  return {
    mockOpenSession: vi.fn(),
    mockConnectSession: vi.fn(),
    mockEndSession: vi.fn(),
    mockGetDrawdownState: vi.fn(),
    mockNudge: vi.fn(),
    mockResolveMoneyBlock: vi.fn(),
    mockResolveAdminMoneyBlock: vi.fn(),
    mockFinalizeExternalDuration: vi.fn(),
    mockUsersFindById: vi.fn(),
    SessionNotFoundError,
    InvalidSessionTransitionError,
    ExternalDurationConflictError,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  SessionNotFoundError,
  InvalidSessionTransitionError,
  ExternalDurationConflictError,
  usersRepository: { findById: mockUsersFindById },
}));
// The real pure platform-authz map — an `admin`/`super_admin` platformRole holds
// MANAGE_PLATFORM_FEES; a plain `user` (or undefined) holds nothing.
vi.mock('@balo/shared/authz', () => ({
  PLATFORM_CAPABILITIES: { MANAGE_PLATFORM_FEES: 'manage_platform_fees' },
  platformRoleHasCapability: (role: string, capability: string) =>
    (role === 'admin' || role === 'super_admin') && capability === 'manage_platform_fees',
}));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = 'user_1';
  },
}));
vi.mock('../../lib/internal-auth.js', () => ({
  requireInternalAuth: async (
    request: { headers: Record<string, unknown> },
    reply: { status: (c: number) => { send: (b: unknown) => void } }
  ) => {
    if (request.headers['x-internal-api-key'] !== 'test-secret') {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  },
}));
vi.mock('../../services/credit-session/index.js', () => ({
  openSession: mockOpenSession,
  connectSession: mockConnectSession,
  endSession: mockEndSession,
  getSessionDrawdownState: mockGetDrawdownState,
  nudgeAdminForTopup: mockNudge,
  resolveSessionMoneyBlock: mockResolveMoneyBlock,
  resolveAdminMoneyBlock: mockResolveAdminMoneyBlock,
  finalizeExternalDuration: mockFinalizeExternalDuration,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { sessionsRoutes } from './index.js';

const EXPERT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
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

    it('threads a valid companyId through to the service (BAL-401)', async () => {
      mockOpenSession.mockResolvedValue({
        ok: true,
        sessionId: SESSION_ID,
        status: 'pending',
        holdId: 'hold_1',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30, companyId: COMPANY_ID },
      });
      expect(res.statusCode).toBe(201);
      expect(mockOpenSession).toHaveBeenCalledWith({
        initiatingMemberId: 'user_1',
        expertProfileId: EXPERT_ID,
        estimatedMinutes: 30,
        companyId: COMPANY_ID,
      });
    });

    it('409s with the eligible companies on company_selection_required (BAL-401)', async () => {
      const companies = [
        { id: COMPANY_ID, name: 'Acme', logoUrl: null },
        { id: EXPERT_ID, name: 'Globex', logoUrl: 'https://logo/globex.png' },
      ];
      mockOpenSession.mockResolvedValue({
        ok: false,
        code: 'company_selection_required',
        companies,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'company_selection_required', companies });
    });

    // ⚠⚠ G1 (second review round) — `meetingId` NO LONGER EXISTS ON THIS SCHEMA. The three
    // tests that used to live here ("forwards a valid meetingId", "omits meetingId entirely
    // when absent", "400s on a non-uuid meetingId") asserted a WIRE CONTRACT that turned out to
    // be the bypass: a caller could send a real `meetingId` with no `durationSource`, silently
    // shadowing the real `'presence'` session `openCaseSessionBestEffort` opens at admission.
    // See `schema.ts`'s docblock. Replaced by the single test below, which asserts the field is
    // now REJECTED, not merely unforwarded.
    it('400s on a body carrying meetingId — the field no longer exists on this wire (G1)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30, meetingId: MEETING_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(mockOpenSession).not.toHaveBeenCalled();
    });

    it('409s on the meeting_not_bookable rejection (BAL-129 / D5)', async () => {
      // ⚠ NO `meetingId` IN THIS PAYLOAD — see the G1 note above. This only pins the STATUS
      // MAPPING for a code the SERVICE can still return (from its own, server-derived
      // `meetingId`, e.g. `joinMeetingAsMember`'s admission call) — 409, not 403:
      // `openErrorStatus` already routes everything but `forbidden` there, and conflating this
      // with the membership gate would want different client behaviour.
      mockOpenSession.mockResolvedValue({ ok: false, code: 'meeting_not_bookable' });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'meeting_not_bookable' });
    });

    it('400s on a non-uuid companyId without calling the service (BAL-401)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30, companyId: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
      expect(mockOpenSession).not.toHaveBeenCalled();
    });

    it.each([
      { code: 'forbidden', status: 403 },
      { code: 'insufficient_no_mandate', status: 409 },
      { code: 'session_in_progress', status: 409 },
      { code: 'settlement_pending', status: 409 },
    ] as const)('$status on the openSession "$code" rejection', async ({ code, status }) => {
      mockOpenSession.mockResolvedValue({ ok: false, code });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expertProfileId: EXPERT_ID, estimatedMinutes: 30 },
      });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ code });
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

  describe('GET /sessions/:id/money-block (BAL-399)', () => {
    it('200s the resolved lens block (client or expert) on success', async () => {
      const block = {
        lens: 'client',
        state: 'finalized',
        sessionId: SESSION_ID,
        amountAudMinor: 15_000,
      };
      mockResolveMoneyBlock.mockResolvedValue({ ok: true, block });
      const res = await app.inject({ method: 'GET', url: `/sessions/${SESSION_ID}/money-block` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(block);
      expect(mockResolveMoneyBlock).toHaveBeenCalledWith(SESSION_ID, 'user_1');
    });

    it('404s (hides existence) when neither a member nor the expert', async () => {
      mockResolveMoneyBlock.mockResolvedValue({ ok: false, code: 'not_found' });
      const res = await app.inject({ method: 'GET', url: `/sessions/${SESSION_ID}/money-block` });
      expect(res.statusCode).toBe(404);
    });

    it('503s (never leaks internals) when resolution throws', async () => {
      mockResolveMoneyBlock.mockRejectedValue(new Error('db down'));
      const res = await app.inject({ method: 'GET', url: `/sessions/${SESSION_ID}/money-block` });
      expect(res.statusCode).toBe(503);
    });
  });

  describe('GET /admin/sessions/:id/money-block (BAL-399)', () => {
    it('403s a non-staff user (lacks platform capability)', async () => {
      mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'user' });
      const res = await app.inject({
        method: 'GET',
        url: `/admin/sessions/${SESSION_ID}/money-block`,
      });
      expect(res.statusCode).toBe(403);
      expect(mockResolveAdminMoneyBlock).not.toHaveBeenCalled();
    });

    it('200s the admin (margin-bearing) block for platform staff', async () => {
      mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'admin' });
      const block = {
        lens: 'admin',
        state: 'finalized',
        sessionId: SESSION_ID,
        marginAudMinor: 3750,
      };
      mockResolveAdminMoneyBlock.mockResolvedValue({ ok: true, block });
      const res = await app.inject({
        method: 'GET',
        url: `/admin/sessions/${SESSION_ID}/money-block`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(block);
      // The service receives the caller's platformRole (self-assert defense-in-depth).
      expect(mockResolveAdminMoneyBlock).toHaveBeenCalledWith(SESSION_ID, 'admin');
    });

    it('404s for staff when the session is missing', async () => {
      mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'super_admin' });
      mockResolveAdminMoneyBlock.mockResolvedValue({ ok: false, code: 'not_found' });
      const res = await app.inject({
        method: 'GET',
        url: `/admin/sessions/${SESSION_ID}/money-block`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('503s (sanitized) for staff when resolution throws', async () => {
      mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'admin' });
      mockResolveAdminMoneyBlock.mockRejectedValue(new Error('db down'));
      const res = await app.inject({
        method: 'GET',
        url: `/admin/sessions/${SESSION_ID}/money-block`,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'money_block_unavailable' });
    });
  });

  describe('POST /internal/sessions/:id/finalize-duration (BAL-399)', () => {
    const validBody = { minutes: 30, path: 'confirmed' };

    it('401s without the internal secret (NOT client-callable)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/internal/sessions/${SESSION_ID}/finalize-duration`,
        payload: validBody,
      });
      expect(res.statusCode).toBe(401);
      expect(mockFinalizeExternalDuration).not.toHaveBeenCalled();
    });

    it('200s and finalizes with the internal secret', async () => {
      mockFinalizeExternalDuration.mockResolvedValue({
        settlementStatus: 'processing',
        overdraftSettledMinor: 1000,
      });
      const res = await app.inject({
        method: 'POST',
        url: `/internal/sessions/${SESSION_ID}/finalize-duration`,
        headers: { 'x-internal-api-key': 'test-secret' },
        payload: validBody,
      });
      expect(res.statusCode).toBe(200);
      expect(mockFinalizeExternalDuration).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        minutes: 30,
        path: 'confirmed',
      });
    });

    it('400s on an invalid path', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/internal/sessions/${SESSION_ID}/finalize-duration`,
        headers: { 'x-internal-api-key': 'test-secret' },
        payload: { minutes: 30, path: 'live_capture' },
      });
      expect(res.statusCode).toBe(400);
      expect(mockFinalizeExternalDuration).not.toHaveBeenCalled();
    });

    it('409s on an ExternalDurationConflictError (a disagreeing second confirmation)', async () => {
      mockFinalizeExternalDuration.mockRejectedValue(new ExternalDurationConflictError());
      const res = await app.inject({
        method: 'POST',
        url: `/internal/sessions/${SESSION_ID}/finalize-duration`,
        headers: { 'x-internal-api-key': 'test-secret' },
        payload: { minutes: 45, path: 'disputed' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('BAL-412 (D9) — a settledByUserId in the body is silently stripped, never forwarded', async () => {
      mockFinalizeExternalDuration.mockResolvedValue({
        settlementStatus: 'not_required',
        overdraftSettledMinor: 0,
      });
      const res = await app.inject({
        method: 'POST',
        url: `/internal/sessions/${SESSION_ID}/finalize-duration`,
        headers: { 'x-internal-api-key': 'test-secret' },
        payload: { ...validBody, settledByUserId: 'user_1' },
      });
      expect(res.statusCode).toBe(200);
      expect(mockFinalizeExternalDuration).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        minutes: 30,
        path: 'confirmed',
      });
    });
  });
});
