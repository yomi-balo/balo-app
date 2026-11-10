import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindTimezoneImpact, mockCheckRateLimit } = vi.hoisted(() => ({
  mockFindTimezoneImpact: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('../../services/availability/timezone-impact.js', () => ({
  findTimezoneImpact: mockFindTimezoneImpact,
}));

vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));

vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { timezoneImpactRoute } from './timezone-impact.js';

const SECRET = 'test-secret';
const EXPERT_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const USER_ID = 'a1b2c3d4-5678-4e9f-8a1b-2c3d4e5f6789';

const headers = { 'x-internal-api-key': SECRET };

function url(params: Record<string, string> = {}): string {
  return `/api/experts/timezone-impact?${new URLSearchParams({
    expertProfileId: EXPERT_ID,
    userId: USER_ID,
    timezone: 'Europe/London',
    ...params,
  }).toString()}`;
}

describe('GET /api/experts/timezone-impact', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    app = Fastify({ logger: false });
    await app.register(timezoneImpactRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 60 });
  });

  it('returns 401 without the internal API key', async () => {
    const res = await app.inject({ method: 'GET', url: url() });

    expect(res.statusCode).toBe(401);
    expect(mockFindTimezoneImpact).not.toHaveBeenCalled();
  });

  it.each([
    ['a bad zone', { timezone: 'Not/AZone' }],
    ['a non-uuid expertProfileId', { expertProfileId: 'nope' }],
    ['a non-uuid userId', { userId: 'nope' }],
  ])('returns 400 for %s', async (_name, over) => {
    const res = await app.inject({ method: 'GET', url: url(over), headers });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'Invalid query parameters');
    expect(res.json()).toHaveProperty('details');
    expect(mockFindTimezoneImpact).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After and skips the lookup when rate-limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 17 });

    const res = await app.inject({ method: 'GET', url: url(), headers });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('17');
    expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 17 });
    expect(mockFindTimezoneImpact).not.toHaveBeenCalled();
  });

  it('keys the rate limit on userId, not expertProfileId', async () => {
    mockFindTimezoneImpact.mockResolvedValue({ outcome: 'expert_not_found' });

    await app.inject({ method: 'GET', url: url(), headers });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      {},
      { keyPrefix: 'ratelimit:timezone-impact', maxRequests: 30, windowSeconds: 60 },
      USER_ID
    );
  });

  it('fails open when the rate limiter throws', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis down'));
    mockFindTimezoneImpact.mockResolvedValue({ outcome: 'expert_not_found' });

    const res = await app.inject({ method: 'GET', url: url(), headers });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the expert profile is not found or not owned', async () => {
    mockFindTimezoneImpact.mockResolvedValue({ outcome: 'expert_not_found' });

    const res = await app.inject({ method: 'GET', url: url(), headers });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Expert profile not found' });
  });

  it('returns the allow-listed 200 shape with ISO dates and no meetingId', async () => {
    mockFindTimezoneImpact.mockResolvedValue({
      outcome: 'ok',
      timezone: 'Europe/London',
      affectedCount: 1,
      truncated: false,
      affected: [
        {
          consultationId: 'c1',
          meetingId: 'm1',
          rateCents: 9900,
          startAt: new Date('2026-11-02T23:00:00Z'),
          endAt: new Date('2026-11-02T23:30:00Z'),
          clientCompanyName: 'Northwind Industrial',
        },
      ],
      nextTimeOff: { startDate: '2026-12-24', endDate: '2027-01-02' },
    });

    const res = await app.inject({ method: 'GET', url: url(), headers });

    expect(res.statusCode).toBe(200);
    expect(mockFindTimezoneImpact).toHaveBeenCalledWith({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      proposedTimezone: 'Europe/London',
    });
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([
      'affected',
      'affectedCount',
      'nextTimeOff',
      'timezone',
      'truncated',
    ]);
    expect(body.affected).toEqual([
      {
        consultationId: 'c1',
        startAt: '2026-11-02T23:00:00.000Z',
        endAt: '2026-11-02T23:30:00.000Z',
        clientCompanyName: 'Northwind Industrial',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('meetingId');
    expect(body.nextTimeOff).toEqual({ startDate: '2026-12-24', endDate: '2027-01-02' });
  });

  it('returns 500 when the service throws', async () => {
    mockFindTimezoneImpact.mockRejectedValue(new Error('db down'));

    const res = await app.inject({ method: 'GET', url: url(), headers });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Failed to check timezone impact' });
  });
});
