import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEndMeeting, mockCheckRateLimit, mockWarn, mockErrorLog } = vi.hoisted(() => ({
  mockEndMeeting: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWarn: vi.fn(),
  mockErrorLog: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: mockErrorLog }),
}));
// ⚠ SPREADS THE REAL MODULE. A `() => ({ checkRateLimit })` factory silently drops
// `RATE_LIMIT_DEADLINE_MS`, which this route imports — and a vitest factory mock throws on any
// export the import graph touches but the factory omits.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string; headers: Record<string, unknown> }) => {
    if (typeof request.headers.authorization !== 'string') return;
    request.userId = USER_ID;
  },
}));
vi.mock('../../services/meetings/end-meeting.js', () => ({ endMeeting: mockEndMeeting }));
// ⚠ `./join.schema.js` is DELIBERATELY NOT MOCKED — the real Zod boundary is what the `400`
// row asserts, and its ABSENCE of an `endedBy` / `outcome` key is a security property: neither
// may ever come from a request body.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { meetingEndRoutes } from './end.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const URL = `/meetings/${MEETING_ID}/end`;
const AUTH = { authorization: 'Bearer test-token' };

describe('POST /meetings/:meetingId/end (BAL-134)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(meetingEndRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 59, ttlSeconds: 3600 });
    mockEndMeeting.mockResolvedValue({
      ok: true,
      status: 'ended',
      alreadyEnded: false,
      endedBy: 'client_principal',
    });
  });

  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  /**
   * ⚠⚠ AUTHENTICATED, UNLIKE TWO OF THE THREE JOIN ROUTES. Ending a meeting for everyone is a
   * mutation over a money-bearing record. A test here means adding a public arm breaks a test
   * rather than breaking the product.
   */
  it('⚠⚠ REQUIRES a Bearer — 401 without one, and the service is never reached', async () => {
    const res = await call({ method: 'POST', url: URL });

    expect(res.statusCode).toBe(401);
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  it('400 on a non-uuid meeting id, before any service work', async () => {
    const res = await call({ method: 'POST', url: '/meetings/not-a-uuid/end', headers: AUTH });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  it('200 on a successful end, reporting the label that was stamped', async () => {
    const res = await call({ method: 'POST', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ended',
      alreadyEnded: false,
      endedBy: 'client_principal',
    });
    expect(mockEndMeeting).toHaveBeenCalledWith({ meetingId: MEETING_ID, userId: USER_ID });
  });

  /**
   * ⚠⚠ D10 — A SECOND END IS `200`, NOT `409`. Two `canEndMeeting` holders can press the button
   * in the same instant, and a `409` would surface a routine race as a user-facing error on the
   * one control that must always work.
   */
  it('⚠⚠ a SECOND end answers 200 with alreadyEnded — never a 409', async () => {
    mockEndMeeting.mockResolvedValue({
      ok: true,
      status: 'ended',
      alreadyEnded: true,
      endedBy: null,
    });

    const res = await call({ method: 'POST', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ended', alreadyEnded: true, endedBy: null });
  });

  /**
   * ⚠ EVERY DENIAL IS A `404`. There is NO `403` anywhere on `/meetings/*` and this surface must
   * not become the exception — a `403` would confirm the meeting exists to somebody who may be
   * holding a guessed uuid.
   */
  it('⚠ 404 on every denial — and NEVER a 403', async () => {
    mockEndMeeting.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const res = await call({ method: 'POST', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'meeting_not_found' });
  });

  it('never echoes an internal message on an unexpected throw', async () => {
    mockEndMeeting.mockRejectedValue(new Error('engagement 44444444 is not resolvable'));

    const res = await call({ method: 'POST', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
  });

  /**
   * ⚠ THE BODY CANNOT INFLUENCE THE OUTCOME. `endedBy` is the server's verdict from
   * `resolveEndAuthority` and `outcome` is deliberately NULL on this path (D5); a body field for
   * either would be self-service attribution on a money-bearing record. Zod strips unknown keys,
   * and the service is called with exactly two arguments.
   */
  it('⚠ a body claiming `endedBy` / `outcome` is IGNORED entirely', async () => {
    await call({
      method: 'POST',
      url: URL,
      headers: AUTH,
      payload: { endedBy: 'expert_host', outcome: 'completed' },
    });

    expect(mockEndMeeting).toHaveBeenCalledWith({ meetingId: MEETING_ID, userId: USER_ID });
  });

  /**
   * ⚠ THE LIVENESS REFUSAL REACHES THE WIRE AS A `409`, NOT A `404`. It is only reachable AFTER
   * tenancy and end authority are both proven, so it confirms nothing to anybody who was not
   * already entitled to know the meeting exists — and telling the holder "not yet" is far more
   * useful than pretending their own consultation does not exist.
   */
  it('409 when the consultation has not started — ending it would be a cancellation', async () => {
    mockEndMeeting.mockResolvedValue({ ok: false, code: 'meeting_not_started' });

    const res = await call({ method: 'POST', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'meeting_not_started' });
  });

  // ── ⚠⚠ S6 — THE RATE LIMIT, WHICH FAILS **CLOSED** ─────────────────────────────────────

  it('⚠ consumes a PER-USER window before any service work', async () => {
    await call({ method: 'POST', url: URL, headers: AUTH });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyPrefix: 'ratelimit:meeting-end:user' }),
      USER_ID
    );
  });

  it('429 with a Retry-After once the window is spent, and the service is never reached', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, ttlSeconds: 900 });

    const res = await call({ method: 'POST', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('900');
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ FAILS **CLOSED**, DELIBERATELY THE OPPOSITE OF THE SIBLING STATE ROUTE — whose docblock
   * cites this route as the fail-closed example. This endpoint WRITES, and what it writes is
   * irreversible (`MEETING_TRANSITIONS.ended === []`, the Daily room is deleted, rejoin is
   * refused), so an unmetered destructive path during a Redis outage is exactly the window an
   * attacker waits for.
   */
  it('⚠⚠ 503 when the limiter is unavailable — never "carry on unlimited"', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));

    const res = await call({ method: 'POST', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(mockEndMeeting).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'redis unreachable' }),
      expect.stringContaining('failing CLOSED')
    );
  });

  it('⚠ a malformed meeting id never consumes somebody’s window', async () => {
    await call({ method: 'POST', url: '/meetings/not-a-uuid/end', headers: AUTH });

    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});
