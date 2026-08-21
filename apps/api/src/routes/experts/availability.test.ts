import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { mockIsPubliclyVisible, mockGetExpertSlots, mockCheckRateLimit } = vi.hoisted(() => ({
  mockIsPubliclyVisible: vi.fn(),
  mockGetExpertSlots: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { isPubliclyVisible: mockIsPubliclyVisible },
}));

vi.mock('../../services/availability/expert-slots-cache.js', () => ({
  getExpertSlots: mockGetExpertSlots,
}));

vi.mock('../../lib/rate-limiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/rate-limiter.js')>();
  return {
    RATE_LIMIT_DEADLINE_MS: actual.RATE_LIMIT_DEADLINE_MS,
    checkRateLimit: mockCheckRateLimit,
  };
});

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import {
  DEFAULT_AVAILABILITY_WINDOW_DAYS,
  MAX_AVAILABILITY_WINDOW_DAYS,
} from '@balo/shared/availability';
import { RATE_LIMIT_DEADLINE_MS } from '../../lib/rate-limiter.js';
import { availabilityRoute } from './availability.js';

const EXPERT_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

const OK_RESULT = {
  status: 'ok' as const,
  expertTimezone: 'UTC',
  generatedAt: new Date('2026-09-01T00:00:00.000Z'),
  slots: [
    { startAt: new Date('2026-09-01T09:00:00.000Z'), maxDurationMinutes: 60 as const },
    { startAt: new Date('2026-09-01T10:00:00.000Z'), maxDurationMinutes: 30 as const },
  ],
};

describe('GET /experts/:expertProfileId/availability', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(availabilityRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 60 });
    mockIsPubliclyVisible.mockResolvedValue(true);
    mockGetExpertSlots.mockResolvedValue(OK_RESULT);
  });

  function inject(
    expertProfileId: string,
    query = ''
  ): Promise<{
    statusCode: number;
    headers: Record<string, unknown>;
    body: string;
    json: () => unknown;
  }> {
    return app.inject({
      method: 'GET',
      url: `/experts/${expertProfileId}/availability${query}`,
    }) as unknown as Promise<{
      statusCode: number;
      headers: Record<string, unknown>;
      body: string;
      json: () => unknown;
    }>;
  }

  // ── Validation ──────────────────────────────────────────────

  it('400 on a non-uuid expertProfileId', async () => {
    const res = await inject('not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(mockIsPubliclyVisible).not.toHaveBeenCalled();
  });

  /**
   * ⚠ REJECTS, never clamps. An out-of-range `days` is a 400, not a silently narrowed window —
   * a caller must never believe it received the horizon it asked for. `days=15` and `days=61`
   * are the two boundary cases that matter: one past the advertise horizon, and the old
   * third horizon the 60→14 cut retired.
   */
  it.each([
    ['days=0 — below the floor', '?days=0'],
    [
      `days=${MAX_AVAILABILITY_WINDOW_DAYS + 1} — one past the advertise horizon`,
      `?days=${MAX_AVAILABILITY_WINDOW_DAYS + 1}`,
    ],
    ['days=61 — the old third horizon is no longer accepted', '?days=61'],
    ['days=abc — not a number', '?days=abc'],
  ])('400 on %s', async (_label, query) => {
    const res = await inject(EXPERT_ID, query);
    expect(res.statusCode).toBe(400);
  });

  // ── Visibility gate ─────────────────────────────────────────

  it('404 when isPubliclyVisible is false, asserting no vendor call was made', async () => {
    mockIsPubliclyVisible.mockResolvedValue(false);
    const res = await inject(EXPERT_ID);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(mockGetExpertSlots).not.toHaveBeenCalled();
  });

  it('404 when the profile vanished between reads (expert_not_found)', async () => {
    mockGetExpertSlots.mockResolvedValue({
      status: 'expert_not_found',
      expertTimezone: '',
      generatedAt: new Date(),
      slots: [],
    });
    const res = await inject(EXPERT_ID);
    expect(res.statusCode).toBe(404);
  });

  // ── 200 shapes ──────────────────────────────────────────────

  it('200 ok — right Cache-Control, days echoed back (validated query value)', async () => {
    const res = await inject(EXPERT_ID, '?days=10');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const body = res.json() as { status: string; days: number; slots: unknown[] };
    expect(body.status).toBe('ok');
    expect(body.days).toBe(10);
    expect(body.slots.length).toBeGreaterThan(0);
  });

  it('a value above MAX_AVAILABILITY_WINDOW_DAYS is rejected (400), never silently clamped', async () => {
    const res = await inject(EXPERT_ID, '?days=90');
    expect(res.statusCode).toBe(400);
  });

  it('days defaults to DEFAULT_AVAILABILITY_WINDOW_DAYS (14) when omitted', async () => {
    const res = await inject(EXPERT_ID);
    const body = res.json() as { days: number };
    expect(body.days).toBe(DEFAULT_AVAILABILITY_WINDOW_DAYS);
  });

  /**
   * §3.4's entire point: the grid is computed and cached under a `days`-FREE key, then sliced on
   * the way out. Every other fixture slot sits inside the window, so nothing exercised the
   * filter's false branch — the slice could have been deleted and the suite stayed green.
   */
  it('slices the cached grid to `days` — a slot beyond the window is not sent', async () => {
    const generatedAt = new Date();
    mockGetExpertSlots.mockResolvedValue({
      status: 'ok' as const,
      expertTimezone: 'UTC',
      generatedAt,
      slots: [
        { startAt: new Date(generatedAt.getTime() + 60 * 60_000), maxDurationMinutes: 60 as const },
        {
          startAt: new Date(generatedAt.getTime() + 10 * 24 * 60 * 60_000),
          maxDurationMinutes: 30 as const,
        },
      ],
    });

    const res = await inject(EXPERT_ID, '?days=1');
    const body = res.json() as { slots: unknown[]; windowEnd: string; days: number };
    expect(body.days).toBe(1);
    expect(body.slots).toHaveLength(1);
    // ⚠ windowEnd is anchored at `generatedAt`, not at this request's `now` — on a cache hit the
    // latter would claim a horizon up to the TTL beyond what was actually computed.
    expect(body.windowEnd).toBe(new Date(generatedAt.getTime() + 24 * 60 * 60_000).toISOString());
  });

  /**
   * ⚠ `ok` + `slots: []` must be UNREACHABLE on the wire. It is reachable without any backend
   * fault — an expert whose next free slot falls beyond `days` — and it sends the client down
   * its `ready` branch with an empty calendar and no highlighted day, silently bypassing the
   * purpose-built `no_slots` empty state.
   */
  it('an ok grid whose every slot falls outside the window is sent as no_slots, not ok+[]', async () => {
    const generatedAt = new Date();
    mockGetExpertSlots.mockResolvedValue({
      status: 'ok' as const,
      expertTimezone: 'UTC',
      generatedAt,
      slots: [
        {
          startAt: new Date(generatedAt.getTime() + 10 * 24 * 60 * 60_000),
          maxDurationMinutes: 60 as const,
        },
      ],
    });

    const res = await inject(EXPERT_ID, '?days=1');
    const body = res.json() as { status: string; slots: unknown[] };
    expect(body.status).toBe('no_slots');
    expect(body.slots).toEqual([]);
  });

  it('200 not_configured — empty slots, right Cache-Control', async () => {
    mockGetExpertSlots.mockResolvedValue({
      status: 'not_configured',
      expertTimezone: 'UTC',
      generatedAt: new Date(),
      slots: [],
    });
    const res = await inject(EXPERT_ID);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const body = res.json() as { status: string; slots: unknown[] };
    expect(body.status).toBe('not_configured');
    expect(body.slots).toEqual([]);
  });

  it('200 no_slots — empty slots, right Cache-Control', async () => {
    mockGetExpertSlots.mockResolvedValue({
      status: 'no_slots',
      expertTimezone: 'UTC',
      generatedAt: new Date(),
      slots: [],
    });
    const res = await inject(EXPERT_ID);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const body = res.json() as { status: string; slots: unknown[] };
    expect(body.status).toBe('no_slots');
    expect(body.slots).toEqual([]);
  });

  // ── unavailable ─────────────────────────────────────────────

  it('503 unavailable — Retry-After, Cache-Control: no-store, no provider named', async () => {
    mockGetExpertSlots.mockResolvedValue({
      status: 'unavailable',
      expertTimezone: 'UTC',
      generatedAt: new Date(),
      slots: [],
    });
    const res = await inject(EXPERT_ID);
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['retry-after']).toBe('30');
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'unavailable', retryAfterSeconds: 30 });
    expect(res.body.toLowerCase()).not.toContain('google');
    expect(res.body.toLowerCase()).not.toContain('microsoft');
    expect(res.body.toLowerCase()).not.toContain('apiroc');
  });

  // ── Rate limiting ───────────────────────────────────────────

  it('429 with Retry-After when rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 42 });
    const res = await inject(EXPERT_ID);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    expect(mockIsPubliclyVisible).not.toHaveBeenCalled();
  });

  it('503 when the limiter Redis throws (fail-closed)', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await inject(EXPERT_ID);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(mockIsPubliclyVisible).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE OUTAGE SHAPE THE TEST ABOVE CANNOT REACH — and the one that actually happens.
   *
   * The rejection case is the EASY one, and it gave this route FALSE ASSURANCE: it made
   * `checkRateLimit` reject, which is precisely what cannot happen during a real Redis outage.
   * `getRedis()` sets `maxRetriesPerRequest: null` (BullMQ requires it), and ioredis only
   * flushes pending commands with an error when that option is a NUMBER — with `null` plus the
   * default `enableOfflineQueue: true`, a command issued while Redis is unreachable is parked
   * and NEVER SETTLES. Before `withDeadline` bounded the call, this route's `catch` was dead
   * code, no 503 was ever sent, and every unauthenticated request hung holding a Fastify
   * connection in the SHARED api process until an upstream proxy killed it — with the limiter
   * counting nothing. `failOpen: false` was a documented lie.
   *
   * Fake timers, not a real 2s wait: the assertion is about the DEADLINE firing.
   */
  it('⚠ 503s on a Redis that never answers at all, instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      // Exactly what ioredis produces while disconnected: pending, forever.
      mockCheckRateLimit.mockReturnValue(new Promise(() => {}));

      const pending = inject(EXPERT_ID);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_DEADLINE_MS + 1);
      const res = await pending;

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
      expect(mockIsPubliclyVisible).not.toHaveBeenCalled();
      expect(mockGetExpertSlots).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the whole deadline — a merely slow Redis is not refused early', async () => {
    vi.useFakeTimers();
    try {
      mockCheckRateLimit.mockReturnValue(new Promise(() => {}));

      let settled = false;
      const pending = inject(EXPERT_ID).then((res) => {
        settled = true;
        return res;
      });

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_DEADLINE_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      expect((await pending).statusCode).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Privacy ─────────────────────────────────────────────────

  it('the ok response body contains no busy-block data', async () => {
    const res = await inject(EXPERT_ID);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('busyBlocks');
    expect(res.body.toLowerCase()).not.toContain('busy');
  });

  // ── Catch-all ───────────────────────────────────────────────

  it('500 on an unexpected failure — opaque body, no message or stack on the wire', async () => {
    mockGetExpertSlots.mockRejectedValue(new Error('postgres connection terminated'));
    const res = await inject(EXPERT_ID);
    expect(res.statusCode).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ error: 'availability_failed' });
    expect(res.body).not.toContain('postgres');
  });
});
