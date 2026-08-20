import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockListUpcoming,
  mockCreate,
  mockSoftDelete,
  mockQueueAdd,
  mockGetQueue,
  mockTrackServer,
  mockFindResolverSettings,
  mockListConfirmedInRange,
  mockResolveCompanies,
  mockCheckRateLimit,
} = vi.hoisted(() => ({
  mockListUpcoming: vi.fn(),
  mockCreate: vi.fn(),
  mockSoftDelete: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockGetQueue: vi.fn(),
  mockTrackServer: vi.fn(),
  mockFindResolverSettings: vi.fn(),
  mockListConfirmedInRange: vi.fn(),
  mockResolveCompanies: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  availabilityOverridesRepository: {
    listUpcoming: mockListUpcoming,
    create: mockCreate,
    softDelete: mockSoftDelete,
  },
  expertsRepository: {
    findResolverSettings: mockFindResolverSettings,
  },
  consultationsRepository: {
    listConfirmedInRange: mockListConfirmedInRange,
  },
  resolveClientCompaniesForMeetings: mockResolveCompanies,
}));

vi.mock('../../lib/queue.js', () => ({
  getQueue: (...args: unknown[]) => {
    mockGetQueue(...args);
    return { add: mockQueueAdd };
  },
}));

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
  createRedisConnection: () => ({}),
}));

// R3 — `importOriginal` so `RATE_LIMIT_DEADLINE_MS` (a real, non-mocked constant `withDeadline`
// reads) survives the mock: a factory that names only `checkRateLimit` silently drops every
// other export, and `RATE_LIMIT_DEADLINE_MS` arriving as `undefined` would collapse every
// `setTimeout` deadline to effectively-0ms — masking exactly the hang this exists to catch.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  AVAILABILITY_SERVER_EVENTS: Object.freeze({
    OVERRIDE_CREATED: 'availability_override_created',
    OVERRIDE_DELETED: 'availability_override_deleted',
  }),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { availabilityOverridesRoutes } from './availability-overrides.js';
import { RATE_LIMIT_DEADLINE_MS } from '../../lib/rate-limiter.js';

// ── Constants ──────────────────────────────────────────────────

const SECRET = 'test-secret';
// Valid v4 UUIDs — zod v4's `.uuid()` enforces the version/variant nibbles.
const EXPERT_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const OVERRIDE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** A full DB row — the DTO must strip created/updated/deletedAt from responses. */
function dbRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: OVERRIDE_ID,
    expertProfileId: EXPERT_ID,
    startDate: '2026-12-24',
    endDate: '2026-12-26',
    label: 'Holiday',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

describe('experts availability-overrides routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    app = Fastify({ logger: false });
    await app.register(availabilityOverridesRoutes);
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

  const authedHeaders = { 'content-type': 'application/json', 'x-internal-api-key': SECRET };

  // ── Auth ──────────────────────────────────────────────────────

  it('returns 401 without the internal API key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/experts/availability-overrides?expertProfileId=${EXPERT_ID}`,
    });
    expect(res.statusCode).toBe(401);
    expect(mockListUpcoming).not.toHaveBeenCalled();
  });

  // ── Validation ────────────────────────────────────────────────

  /**
   * Every rejected CREATE body, as one table. Each row asserts the same two things — a 400 and
   * that nothing reached the repository — so they differ only in the payload that must be
   * refused. Parameterised rather than written out (SonarCloud S4144 flagged the hand-written
   * run), matching `consultations.integration.test.ts`'s `OVERLAP_CASES`.
   *
   * ⚠ The span row is the load-bearing one: S3 added the 366-day guard to the conflicts QUERY
   * but shipped no test for the CREATE arm, which is the one with the durable consequence —
   * an unbounded `endDate` (e.g. `9999-12-31`) would be STORED, permanently widening every
   * future availability-cache rebuild's forward scan rather than just failing one read.
   */
  const INVALID_CREATE_BODIES: ReadonlyArray<{
    readonly name: string;
    readonly payload: Record<string, unknown>;
  }> = [
    {
      name: 'endDate is before startDate',
      payload: { expertProfileId: EXPERT_ID, startDate: '2026-12-26', endDate: '2026-12-24' },
    },
    {
      name: 'a date is not ISO `YYYY-MM-DD`',
      payload: { expertProfileId: EXPERT_ID, startDate: '24-12-2026', endDate: '2026-12-26' },
    },
    {
      name: 'the label exceeds 80 characters',
      payload: {
        expertProfileId: EXPERT_ID,
        startDate: '2026-12-24',
        endDate: '2026-12-26',
        label: 'x'.repeat(81),
      },
    },
    {
      name: 'the span exceeds 366 days (S3)',
      payload: { expertProfileId: EXPERT_ID, startDate: '2026-01-01', endDate: '2027-06-01' },
    },
  ];

  it.each(INVALID_CREATE_BODIES)('returns 400 when $name', async ({ payload }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── Create ────────────────────────────────────────────────────

  it('creates a block, returns the allow-listed DTO, enqueues a rebuild, and tracks the event', async () => {
    mockCreate.mockResolvedValue(dbRow());

    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
      payload: {
        expertProfileId: EXPERT_ID,
        startDate: '2026-12-24',
        endDate: '2026-12-26',
        label: 'Holiday',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { override: Record<string, unknown> };
    expect(body.override).toEqual({
      id: OVERRIDE_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      label: 'Holiday',
    });
    // No timestamp leak.
    expect(body.override).not.toHaveProperty('createdAt');
    expect(body.override).not.toHaveProperty('deletedAt');

    expect(mockCreate).toHaveBeenCalledWith({
      expertProfileId: EXPERT_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      label: 'Holiday',
    });
    // Rebuild enqueued (deduped by expert).
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'rebuild-availability-cache',
      { expertProfileId: EXPERT_ID },
      expect.objectContaining({ jobId: `availability-${EXPERT_ID}` })
    );
    // Analytics: 3-day inclusive block with a label.
    expect(mockTrackServer).toHaveBeenCalledWith('availability_override_created', {
      duration_days: 3,
      has_label: true,
      distinct_id: EXPERT_ID,
    });
  });

  it('reports has_label false and a single-day duration for a labelless single-day block', async () => {
    mockCreate.mockResolvedValue(
      dbRow({ startDate: '2026-12-25', endDate: '2026-12-25', label: null })
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
      payload: { expertProfileId: EXPERT_ID, startDate: '2026-12-25', endDate: '2026-12-25' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockTrackServer).toHaveBeenCalledWith('availability_override_created', {
      duration_days: 1,
      has_label: false,
      distinct_id: EXPERT_ID,
    });
  });

  it('normalizes a whitespace-only label to null (stored as null, has_label false)', async () => {
    mockCreate.mockResolvedValue(dbRow({ label: null }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
      payload: {
        expertProfileId: EXPERT_ID,
        startDate: '2026-12-24',
        endDate: '2026-12-26',
        label: '   ',
      },
    });

    expect(res.statusCode).toBe(200);
    // Repo receives a normalized null, never an empty string.
    expect(mockCreate).toHaveBeenCalledWith({
      expertProfileId: EXPERT_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      label: null,
    });
    expect((res.json() as { override: { label: string | null } }).override.label).toBeNull();
    expect(mockTrackServer).toHaveBeenCalledWith('availability_override_created', {
      duration_days: 3,
      has_label: false,
      distinct_id: EXPERT_ID,
    });
  });

  it('returns 500 and does not enqueue when create fails', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
      payload: { expertProfileId: EXPERT_ID, startDate: '2026-12-24', endDate: '2026-12-26' },
    });

    expect(res.statusCode).toBe(500);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  // ── List ──────────────────────────────────────────────────────

  it('lists blocks as allow-listed DTOs without leaking timestamps', async () => {
    mockListUpcoming.mockResolvedValue([dbRow()]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/experts/availability-overrides?expertProfileId=${EXPERT_ID}`,
      headers: authedHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(mockListUpcoming).toHaveBeenCalledWith(EXPERT_ID);
    const body = res.json() as { overrides: Record<string, unknown>[] };
    expect(body.overrides).toEqual([
      { id: OVERRIDE_ID, startDate: '2026-12-24', endDate: '2026-12-26', label: 'Holiday' },
    ]);
    const [first] = body.overrides;
    expect(first).not.toHaveProperty('createdAt');
    expect(first).not.toHaveProperty('deletedAt');
    expect(first).not.toHaveProperty('expertProfileId');
  });

  it('returns 400 when the list query is missing expertProfileId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Delete ────────────────────────────────────────────────────

  it('soft-deletes, enqueues a rebuild, and tracks the delete event', async () => {
    mockSoftDelete.mockResolvedValue(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides/delete',
      headers: authedHeaders,
      payload: { expertProfileId: EXPERT_ID, overrideId: OVERRIDE_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockSoftDelete).toHaveBeenCalledWith(OVERRIDE_ID, EXPERT_ID);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'rebuild-availability-cache',
      { expertProfileId: EXPERT_ID },
      expect.objectContaining({ jobId: `availability-${EXPERT_ID}` })
    );
    expect(mockTrackServer).toHaveBeenCalledWith('availability_override_deleted', {
      distinct_id: EXPERT_ID,
    });
  });

  it('returns 404 (no enqueue, no event) when the delete matches nothing', async () => {
    mockSoftDelete.mockResolvedValue(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides/delete',
      headers: authedHeaders,
      payload: { expertProfileId: EXPERT_ID, overrideId: OVERRIDE_ID },
    });

    expect(res.statusCode).toBe(404);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  // ── Conflicts (BAL-416) ───────────────────────────────────────

  describe('conflicts route', () => {
    // Valid v4 UUIDs — zod v4's `.uuid()` enforces the version/variant nibbles.
    const USER_ID = 'a1b2c3d4-5678-4e9f-8a1b-2c3d4e5f6789';
    const OTHER_USER_ID = 'f1e2d3c4-b5a6-4978-9a8b-7c6d5e4f3a2b';

    const settings = {
      userId: USER_ID,
      timezone: 'UTC',
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 30,
      minimumNoticeMinutes: 120,
    };

    /**
     * Q2 fix — clock-relative fixture dates, so this suite can never go red from the D4
     * forward clamp just because time passed (the old suite hard-coded `2026-12-24` against
     * the REAL clock the route doesn't let a test override). UTC getters, matching
     * `settings.timezone: 'UTC'` — mirrors the `localIsoOffset` pattern in
     * `date-overrides-card.test.tsx`, adapted to UTC since this drives the route directly
     * rather than a browser-local component.
     */
    function utcIsoOffset(offsetDays: number): string {
      const now = new Date();
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays)
      );
      const y = d.getUTCFullYear().toString().padStart(4, '0');
      const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
      const day = d.getUTCDate().toString().padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    // Always ~30 days out — far enough that the forward clamp never engages, however long
    // this fixture lives.
    const START_DATE = utcIsoOffset(30);
    const END_DATE = utcIsoOffset(32);

    function conflictsUrl(params: Record<string, string>): string {
      return `/api/experts/availability-overrides/conflicts?${new URLSearchParams(params).toString()}`;
    }

    function baseParams(over: Partial<Record<string, string>> = {}): Record<string, string> {
      return {
        expertProfileId: EXPERT_ID,
        userId: USER_ID,
        startDate: START_DATE,
        endDate: END_DATE,
        ...over,
      };
    }

    it('returns 401 without the internal API key on the conflicts route', async () => {
      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams()),
      });
      expect(res.statusCode).toBe(401);
      expect(mockFindResolverSettings).not.toHaveBeenCalled();
    });

    it('returns 400 when endDate is before startDate on the conflicts route', async () => {
      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams({ startDate: END_DATE, endDate: START_DATE })),
        headers: authedHeaders,
      });
      expect(res.statusCode).toBe(400);
      expect(mockFindResolverSettings).not.toHaveBeenCalled();
    });

    it('returns 400 when userId is missing or not a uuid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/experts/availability-overrides/conflicts?expertProfileId=${EXPERT_ID}&startDate=${START_DATE}&endDate=${END_DATE}`,
        headers: authedHeaders,
      });
      expect(res.statusCode).toBe(400);
      expect(mockFindResolverSettings).not.toHaveBeenCalled();
    });

    it('returns 400 when the span exceeds 366 days (S3)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams({ startDate: utcIsoOffset(0), endDate: utcIsoOffset(400) })),
        headers: authedHeaders,
      });
      expect(res.statusCode).toBe(400);
      expect(mockFindResolverSettings).not.toHaveBeenCalled();
    });

    it('returns 429 with Retry-After and skips the lookup when rate-limited (S4)', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 42 });

      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams()),
        headers: authedHeaders,
      });

      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 42 });
      expect(res.headers['retry-after']).toBe('42');
      expect(mockFindResolverSettings).not.toHaveBeenCalled();
    });

    it('fails OPEN (proceeds) when the rate limiter itself throws', async () => {
      mockCheckRateLimit.mockRejectedValue(new Error('redis down'));
      mockFindResolverSettings.mockResolvedValue(settings);
      mockListConfirmedInRange.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams()),
        headers: authedHeaders,
      });

      expect(res.statusCode).toBe(200);
    });

    /**
     * R3 — the branch the round-1 test above ("fails OPEN when the rate limiter itself
     * throws") does NOT exercise: `getRedis()` sets `maxRetriesPerRequest: null` (BullMQ
     * requires it), and ioredis only fails pending commands with an error when that option
     * is a NUMBER. With `null`, a command issued during a Redis outage is parked in the
     * offline queue and NEVER SETTLES — so a `checkRateLimit` that hangs forever (exactly
     * what that outage produces) used to hang this request too, never reaching the `catch`
     * that answers fail-open. `withDeadline` is what makes the `catch` reachable at all.
     *
     * Fake timers, not a real 2s wait: the assertion is about the DEADLINE firing, and
     * advancing the clock proves that far more precisely than sleeping does.
     */
    it('fails OPEN within the deadline when the rate limiter HANGS, instead of hanging the request (R3)', async () => {
      vi.useFakeTimers();
      try {
        // Exactly what ioredis produces while disconnected: pending, forever.
        mockCheckRateLimit.mockReturnValue(new Promise(() => {}));
        mockFindResolverSettings.mockResolvedValue(settings);
        mockListConfirmedInRange.mockResolvedValue([]);

        const pending = app.inject({
          method: 'GET',
          url: conflictsUrl(baseParams()),
          headers: authedHeaders,
        });
        await vi.advanceTimersByTimeAsync(RATE_LIMIT_DEADLINE_MS + 1);
        const res = await pending;

        expect(res.statusCode).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keys the rate limit on `userId`, not `expertProfileId` (R3 — a bogus userId must not spend the real expert's bucket)", async () => {
      mockFindResolverSettings.mockResolvedValue(settings);
      mockListConfirmedInRange.mockResolvedValue([]);

      await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams({ userId: OTHER_USER_ID })),
        headers: authedHeaders,
      });

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:availability-conflicts' }),
        OTHER_USER_ID
      );
      expect(mockCheckRateLimit).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        EXPERT_ID
      );
    });

    it('returns the zero-conflict shape', async () => {
      mockFindResolverSettings.mockResolvedValue(settings);
      mockListConfirmedInRange.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams()),
        headers: authedHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        conflictCount: 0,
        durationDays: 3,
        timezone: 'UTC',
        truncated: false,
        conflicts: [],
      });
      expect(mockResolveCompanies).not.toHaveBeenCalled();
    });

    it('returns the full conflict shape, ISO-serialised, with a resolved company name', async () => {
      mockFindResolverSettings.mockResolvedValue(settings);
      mockListConfirmedInRange.mockResolvedValue([
        {
          id: 'consult-1',
          meetingId: 'meeting-1',
          expertProfileId: EXPERT_ID,
          startAt: new Date(`${START_DATE}T03:00:00.000Z`),
          endAt: new Date(`${START_DATE}T04:00:00.000Z`),
          status: 'confirmed',
        },
      ]);
      mockResolveCompanies.mockResolvedValue(
        new Map([['meeting-1', { companyId: 'co-1', companyName: 'Northwind Industrial' }]])
      );

      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams()),
        headers: authedHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        conflictCount: 1,
        durationDays: 3,
        timezone: 'UTC',
        truncated: false,
        conflicts: [
          {
            consultationId: 'consult-1',
            startAt: `${START_DATE}T03:00:00.000Z`,
            endAt: `${START_DATE}T04:00:00.000Z`,
            clientCompanyName: 'Northwind Industrial',
          },
        ],
      });
      // S2 — the expert containment term is threaded through, not dropped.
      expect(mockResolveCompanies).toHaveBeenCalledWith(['meeting-1'], EXPERT_ID);
    });

    it('returns 404 when the expert profile is not found', async () => {
      mockFindResolverSettings.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams()),
        headers: authedHeaders,
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns the SAME 404 shape when userId does not own this expert profile (S1) — no oracle', async () => {
      mockFindResolverSettings.mockResolvedValue(settings);

      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams({ userId: OTHER_USER_ID })),
        headers: authedHeaders,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Expert profile not found' });
      expect(mockListConfirmedInRange).not.toHaveBeenCalled();
    });

    it('returns 500 and logs when the service throws', async () => {
      mockFindResolverSettings.mockRejectedValue(new Error('db down'));

      const res = await app.inject({
        method: 'GET',
        url: conflictsUrl(baseParams()),
        headers: authedHeaders,
      });

      expect(res.statusCode).toBe(500);
    });

    it('logs the truncation notice via request.log.info, not the module logger (Q5)', async () => {
      const mockRequestLog = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
      };
      mockRequestLog.child.mockReturnValue(mockRequestLog);
      const loggedApp = Fastify({ logger: false });
      loggedApp.addHook('onRequest', (request, _reply, done) => {
        request.log = mockRequestLog as unknown as FastifyInstance['log'];
        done();
      });
      await loggedApp.register(availabilityOverridesRoutes);
      await loggedApp.ready();

      mockFindResolverSettings.mockResolvedValue(settings);
      const rows = Array.from({ length: 25 }, (_, i) => ({
        id: `c${i.toString().padStart(2, '0')}`,
        meetingId: `meeting-${i}`,
        expertProfileId: EXPERT_ID,
        startAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
        endAt: new Date(Date.UTC(2026, 0, 1, 0, i + 1)),
        status: 'confirmed',
      }));
      mockListConfirmedInRange.mockResolvedValue(rows);
      mockResolveCompanies.mockResolvedValue(new Map());

      const res = await loggedApp.inject({
        method: 'GET',
        url: conflictsUrl(baseParams()),
        headers: authedHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(mockRequestLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ expertProfileId: EXPERT_ID, conflictCount: 25, detailCount: 20 }),
        'Override-conflict check truncated the detail list'
      );

      await loggedApp.close();
    });
  });
});
