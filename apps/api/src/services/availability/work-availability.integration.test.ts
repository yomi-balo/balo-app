import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * BAL-591 — pausing new work against a real Postgres: the DB availability cache (search badge
 * and ranking) empties without a vendor read, resuming restores it, and the PUT route commits
 * the flag and its audit row together and drops the Redis grid.
 *
 * Queue and Redis are the only fakes: `getQueue` would open a live Redis connection, and the
 * slot cache IS Redis. Everything else, including the enqueue helper, runs for real.
 */

const { mockQueueAdd, mockGetQueue, mockRedisDel } = vi.hoisted(() => {
  const add = vi.fn().mockResolvedValue({ id: 'job' });
  return {
    mockQueueAdd: add,
    mockGetQueue: vi.fn(() => ({ add })),
    mockRedisDel: vi.fn().mockResolvedValue(2),
  };
});

vi.mock('../../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queue.js')>()),
  getQueue: mockGetQueue,
}));
vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({ del: mockRedisDel }),
  createRedisConnection: () => ({}),
}));

import {
  auditEvents,
  availabilityCache,
  availabilityRulesRepository,
  and,
  db,
  eq,
  expertProfiles,
  expertsRepository,
  referenceDataRepository,
  usersRepository,
} from '@balo/db';
import { scheduleRoutes } from '../../routes/experts/schedule.js';
import { vendorBusyProvider } from './vendor-busy.js';
import { resolveAndCacheAvailability } from './resolve-and-cache.js';

const NOW = new Date('2026-09-07T00:00:00.000Z');
const NINE_AM = '2026-09-07T09:00:00.000Z';
const SECRET = 'bal591-secret';
const ACTION = 'expert_work_availability.changed';

async function seedBookableExpert(): Promise<{ expertProfileId: string; userId: string }> {
  const marker = randomUUID();
  const user = await usersRepository.create({
    workosId: `bal591w_${marker}`,
    email: `bal591w-${marker}@test.local`,
    firstName: 'Pause',
    lastName: 'Expert',
  });
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const profile = await expertsRepository.createDraft({
    userId: user.id,
    verticalId: vertical.id,
    type: 'freelancer',
    firstName: 'Pause',
    lastName: 'Expert',
  });
  // Approved + searchable with a live owner, so `findPublicVisibility` answers a row until the
  // pause alone changes it.
  await db
    .update(expertProfiles)
    .set({ timezone: 'UTC', approvedAt: new Date(), searchable: true })
    .where(eq(expertProfiles.id, profile.id));
  await availabilityRulesRepository.replaceForExpert(
    profile.id,
    [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '17:00' }))
  );
  return { expertProfileId: profile.id, userId: user.id };
}

async function cachedEarliest(expertProfileId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select()
    .from(availabilityCache)
    .where(eq(availabilityCache.expertProfileId, expertProfileId));
  return row === undefined ? undefined : (row.earliestAvailableAt?.toISOString() ?? null);
}

/** Explicit `horizonDays` / `minMinutes` so an env override cannot change the expectations. */
function rebuild(expertProfileId: string): ReturnType<typeof resolveAndCacheAvailability> {
  return resolveAndCacheAvailability(expertProfileId, {
    now: NOW,
    horizonDays: 14,
    minMinutes: 15,
  });
}

let listBusyBlocks: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  listBusyBlocks = vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockResolvedValue([]);
});

afterEach(() => {
  listBusyBlocks.mockRestore();
});

describe('resolveAndCacheAvailability while paused', () => {
  it('writes earliest_available_at = null and never reads the vendor', async () => {
    const { expertProfileId } = await seedBookableExpert();
    expect((await rebuild(expertProfileId)).earliestAvailableAt?.toISOString()).toBe(NINE_AM);
    expect(await cachedEarliest(expertProfileId)).toBe(NINE_AM);
    listBusyBlocks.mockClear();

    await expertsRepository.setAvailableForWork({
      expertProfileId,
      availableForWork: false,
      actorUserId: null,
    });
    const result = await rebuild(expertProfileId);

    expect(result).toEqual({ status: 'completed', earliestAvailableAt: null });
    expect(await cachedEarliest(expertProfileId)).toBeNull();
    expect(listBusyBlocks).not.toHaveBeenCalled();
  });

  it('a pause that lands mid-rebuild wins: the stale compute writes null, not its slot', async () => {
    const { expertProfileId } = await seedBookableExpert();
    // The vendor read is the window in which the expert pauses, after the first settings read.
    listBusyBlocks.mockImplementationOnce(async () => {
      await expertsRepository.setAvailableForWork({
        expertProfileId,
        availableForWork: false,
        actorUserId: null,
      });
      return [];
    });

    const result = await rebuild(expertProfileId);

    expect(result).toEqual({ status: 'completed', earliestAvailableAt: null });
    expect(await cachedEarliest(expertProfileId)).toBeNull();
  });

  it('creates the cleared row for an expert that had none', async () => {
    const { expertProfileId } = await seedBookableExpert();
    await expertsRepository.setAvailableForWork({
      expertProfileId,
      availableForWork: false,
      actorUserId: null,
    });
    expect(await cachedEarliest(expertProfileId)).toBeUndefined();

    await rebuild(expertProfileId);

    expect(await cachedEarliest(expertProfileId)).toBeNull();
  });

  it('resuming restores the same earliest slot from the untouched schedule', async () => {
    const { expertProfileId } = await seedBookableExpert();
    await expertsRepository.setAvailableForWork({
      expertProfileId,
      availableForWork: false,
      actorUserId: null,
    });
    await rebuild(expertProfileId);
    expect(await cachedEarliest(expertProfileId)).toBeNull();

    await expertsRepository.setAvailableForWork({
      expertProfileId,
      availableForWork: true,
      actorUserId: null,
    });
    await rebuild(expertProfileId);

    expect(await cachedEarliest(expertProfileId)).toBe(NINE_AM);
    expect(listBusyBlocks).toHaveBeenCalledTimes(1);
  });

  it('a paused expert does not affect another expert in the same rebuild window', async () => {
    const paused = await seedBookableExpert();
    const bystander = await seedBookableExpert();
    await expertsRepository.setAvailableForWork({
      expertProfileId: paused.expertProfileId,
      availableForWork: false,
      actorUserId: null,
    });

    await rebuild(paused.expertProfileId);
    await rebuild(bystander.expertProfileId);

    expect(await cachedEarliest(paused.expertProfileId)).toBeNull();
    expect(await cachedEarliest(bystander.expertProfileId)).toBe(NINE_AM);
  });
});

describe('PUT /api/experts/:id/work-availability (real DB)', () => {
  let app: FastifyInstance;

  async function put(
    expertProfileId: string,
    payload: Record<string, unknown>
  ): Promise<{ statusCode: number; json: () => Record<string, unknown> }> {
    return app.inject({
      method: 'PUT',
      url: `/api/experts/${expertProfileId}/work-availability`,
      headers: { 'content-type': 'application/json', 'x-internal-api-key': SECRET },
      payload,
    }) as unknown as Promise<{ statusCode: number; json: () => Record<string, unknown> }>;
  }

  async function auditRows(expertProfileId: string): Promise<(typeof auditEvents.$inferSelect)[]> {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'expert_profile'),
          eq(auditEvents.entityId, expertProfileId),
          eq(auditEvents.action, ACTION)
        )
      );
  }

  beforeEach(async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    app = Fastify({ logger: false });
    await app.register(scheduleRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  it('a pause commits the flag and one audit row, drops the Redis grid, enqueues the rebuild', async () => {
    const { expertProfileId, userId } = await seedBookableExpert();
    expect(await expertsRepository.findPublicVisibility(expertProfileId)).toEqual({
      availableForWork: true,
    });

    const res = await put(expertProfileId, { availableForWork: false, actorUserId: userId });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, availableForWork: false, changed: true });
    expect(await expertsRepository.findPublicVisibility(expertProfileId)).toEqual({
      availableForWork: false,
    });
    const profile = await db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
      columns: { availableForWork: true },
    });
    expect(profile?.availableForWork).toBe(false);
    const rows = await auditRows(expertProfileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ from: true, to: false });
    expect(rows[0]?.actorUserId).toBe(userId);
    expect(mockRedisDel).toHaveBeenCalledWith(
      `availability:v1:${expertProfileId}`,
      `availability:breaker:v1:${expertProfileId}`
    );
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('repeating the same write writes no second audit row but still drops the cache and enqueues', async () => {
    const { expertProfileId } = await seedBookableExpert();
    await put(expertProfileId, { availableForWork: false });
    vi.clearAllMocks();

    const res = await put(expertProfileId, { availableForWork: false });

    expect(res.json()).toEqual({ success: true, availableForWork: false, changed: false });
    expect(await auditRows(expertProfileId)).toHaveLength(1);
    // A retry after a post-commit failure lands here with `changed:false`; the cache refresh
    // must still run or `availability_cache` keeps the pre-toggle earliest time.
    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an unknown profile and writes nothing', async () => {
    const res = await put(randomUUID(), { availableForWork: false });

    expect(res.statusCode).toBe(404);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('the GET schedule body reports the pause', async () => {
    const { expertProfileId } = await seedBookableExpert();
    await put(expertProfileId, { availableForWork: false });

    const res = (await app.inject({
      method: 'GET',
      url: `/api/experts/${expertProfileId}/schedule`,
      headers: { 'x-internal-api-key': SECRET },
    })) as unknown as { statusCode: number; json: () => { availableForWork: boolean } };

    expect(res.statusCode).toBe(200);
    expect(res.json().availableForWork).toBe(false);
  });
});
