import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockListUpcoming,
  mockCreate,
  mockSoftDelete,
  mockQueueAdd,
  mockGetQueue,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockListUpcoming: vi.fn(),
  mockCreate: vi.fn(),
  mockSoftDelete: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockGetQueue: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  availabilityOverridesRepository: {
    listUpcoming: mockListUpcoming,
    create: mockCreate,
    softDelete: mockSoftDelete,
  },
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

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CALENDAR_SERVER_EVENTS: Object.freeze({
    AVAILABILITY_CACHE_REBUILT: 'calendar_availability_cache_rebuilt',
    SYNC_PENDING_AUTO_RESOLVED: 'calendar_sync_pending_auto_resolved',
    AVAILABILITY_OVERRIDE_CREATED: 'availability_override_created',
    AVAILABILITY_OVERRIDE_DELETED: 'availability_override_deleted',
  }),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { availabilityOverridesRoutes } from './availability-overrides.js';

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

  it('returns 400 when endDate is before startDate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
      payload: { expertProfileId: EXPERT_ID, startDate: '2026-12-26', endDate: '2026-12-24' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-ISO date', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
      payload: { expertProfileId: EXPERT_ID, startDate: '24-12-2026', endDate: '2026-12-26' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when the label exceeds 80 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/experts/availability-overrides',
      headers: authedHeaders,
      payload: {
        expertProfileId: EXPERT_ID,
        startDate: '2026-12-24',
        endDate: '2026-12-26',
        label: 'x'.repeat(81),
      },
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
});
