import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * BAL-428 F4 — THE END-TO-END PROOF: a booking written through `meetingsRepository`
 * actually moves what the marketplace advertises.
 *
 * Every other test in this ticket verifies ONE layer. `consultation-projection.
 * integration.test.ts` proves the projection row is written; `meeting-availability.test.ts`
 * proves the rebuild is enqueued. NEITHER proves the thing the ticket is actually about:
 * that after booking a slot, the BAL-243 resolver stops offering it. That claim spans
 * `meetings` → `meeting_contexts` → the projection → `consultations_expert_status_range_idx`
 * → the resolver → `availability_cache`, and only a real Postgres can carry it end to end.
 *
 * ⚠ THIS FILE LIVES IN `apps/api` BUT RUNS FROM `packages/db/vitest.config.integration.ts`.
 * That config's `root` is the repo root and its `globalSetup`/`setupFiles` are absolute, so
 * one testcontainer serves both packages — a second config would roughly double the
 * integration job's CI time for this one file. `@balo/db`'s `main` is `./src/index.ts`, so
 * the `db` binding an `apps/api` service imports IS the live binding `setup-integration.ts`
 * reassigns via `_setDb`; every write below therefore lands in the per-test transaction and
 * rolls back with it. `apps/api/vitest.config.ts` EXCLUDES `*.integration.test.ts` so the
 * unit job does not also pick this up with no database.
 *
 * ⚠ `pnpm test:integration` PASSES VACUOUSLY WITHOUT DOCKER (`passWithNoTests: true` prints
 * "No test files found" and exits 0). Check the reported test COUNT, never the exit code.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

/**
 * The queue, and ONLY the queue. `enqueueAvailabilityCacheRebuild` runs FOR REAL — it is
 * the thing under test — but `getQueue` would otherwise open a live Redis connection
 * (`getRedis()` throws without `REDIS_URL`, and would connect with one). Mocking one layer
 * lower means the jobId, the payload and the queue name are all still asserted rather than
 * stubbed away.
 */
const { mockQueueAdd, mockGetQueue } = vi.hoisted(() => {
  const add = vi.fn().mockResolvedValue({ id: 'seed-job' });
  return { mockQueueAdd: add, mockGetQueue: vi.fn(() => ({ add })) };
});

vi.mock('../../lib/queue.js', () => ({ getQueue: mockGetQueue }));

/**
 * EVERYTHING COMES FROM THE `@balo/db` BARREL, INCLUDING THE FIXTURES — deliberately.
 *
 * `packages/db`'s own integration tests use `src/test/factories/*`, which are NOT in the
 * package's `exports` (they must never be reachable from production code). Reaching them
 * from here by relative path would pull `packages/db/src/**` into `apps/api`'s tsconfig
 * program as SOURCE files rather than node_modules-external ones, and `tsc --noEmit` then
 * fails TS6059 on `rootDir: "src"` — for the factories AND for every file `@balo/db`
 * transitively imports. Widening `exports` to publish the factories would fix the compile
 * at the cost of making test-only helpers importable from production code. Neither trade is
 * worth it for ~20 lines of fixture, so `seedBookableExpert` below builds the graph from
 * the same repositories a real caller would.
 */
import {
  availabilityCache,
  availabilityRulesRepository,
  calendarRepository,
  caseEngagementsRepository,
  companies,
  consultations,
  db,
  eq,
  expertProfiles,
  expertsRepository,
  findProjectionDrift,
  findProjectionForMeeting,
  referenceDataRepository,
  usersRepository,
} from '@balo/db';
import { randomUUID } from 'node:crypto';
import { AVAILABILITY_CACHE_QUEUE } from '../../jobs/availability-cache.js';
import {
  bookMeeting,
  cancelMeeting,
  rescheduleMeeting,
  softDeleteMeeting,
} from '../meetings/meeting-availability.js';
import { isWindowAvailableForExpert } from './window-availability.js';
import { resolveAndCacheAvailability } from './resolve-and-cache.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A FIXED instant, so every expected value below is a literal rather than arithmetic.
 * 2026-09-07 is a Monday, but the fixture opens a window on ALL SEVEN weekdays so nothing
 * here depends on that — or on the machine's timezone.
 */
const NOW = new Date('2026-09-07T00:00:00.000Z');
const NINE_AM = '2026-09-07T09:00:00.000Z';

/** `'09:00'` → the UTC instant on the fixture's date. The expert's tz is pinned to UTC. */
function at(hourMinute: string): Date {
  return new Date(`2026-09-07T${hourMinute}:00.000Z`);
}

const log = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as FastifyBaseLogger;

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

interface BookableExpert {
  expertProfileId: string;
  /** A live case engagement whose `expert_profile_id` is this expert — the context id. */
  engagementId: string;
}

/**
 * An expert who is bookable 09:00–17:00 UTC every day, plus a client company and a live
 * case engagement to hang a meeting context off. The booking buffers and minimum notice
 * stay at their column defaults (all `0`), so `earliest_available_at` is exactly the window
 * start rather than the start plus some inherited policy.
 */
async function seedBookableExpert(): Promise<BookableExpert> {
  const marker = randomUUID();
  const user = await usersRepository.create({
    workosId: `bal428_${marker}`,
    email: `bal428-${marker}@test.local`,
    firstName: 'Booking',
    lastName: 'Expert',
  });

  // Seeded by `global-setup.ts` and never rolled back, so this always resolves.
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const profile = await expertsRepository.createDraft({
    userId: user.id,
    verticalId: vertical.id,
    type: 'freelancer',
    firstName: 'Booking',
    lastName: 'Expert',
  });

  // PIN THE TIMEZONE. Availability rules are wall-clock in the expert's OWN tz, so leaving
  // it implicit would make every expectation below depend on a column default that is free
  // to change. It is already 'UTC'; this makes the dependency explicit rather than lucky.
  await db.update(expertProfiles).set({ timezone: 'UTC' }).where(eq(expertProfiles.id, profile.id));

  await availabilityRulesRepository.replaceForExpert(
    profile.id,
    ALL_WEEKDAYS.map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '17:00' }))
  );

  const [company] = await db
    .insert(companies)
    .values({ name: `BAL-428 client ${marker}`, isPersonal: true })
    .returning({ id: companies.id });
  if (company === undefined) {
    throw new Error('fixture: company insert returned no row');
  }

  const engagement = await caseEngagementsRepository.create({
    companyId: company.id,
    expertProfileId: profile.id,
    title: 'BAL-428 booking fixture',
    description: '<p>Already-sanitised HTML, exactly as a real web caller would pass.</p>',
  });

  return { expertProfileId: profile.id, engagementId: engagement.id };
}

/**
 * Run the real resolver at the fixed `NOW` and return what it would advertise.
 *
 * `horizonDays` and `minMinutes` are passed EXPLICITLY, not left to their defaults: both
 * fall back to `RESOLVER_HORIZON_DAYS` / `MIN_CONSULTATION_MINUTES` env vars, and an
 * environment that happened to set either could silently change every expectation here
 * (a large `minMinutes`, in particular, would discard the post-booking remainder and turn
 * a real regression into a green run). An explicit option outranks the env.
 */
async function resolveEarliest(expertProfileId: string): Promise<string | null> {
  const { earliestAvailableAt } = await resolveAndCacheAvailability(expertProfileId, {
    busyBlocks: [],
    now: NOW,
    horizonDays: 14,
    minMinutes: 15,
  });
  return earliestAvailableAt?.toISOString() ?? null;
}

/** Book `[start, end)` against the expert's case engagement, through the service seam. */
async function book(
  expert: BookableExpert,
  start: string,
  end: string
): Promise<{ meetingId: string; expertProfileId: string | null }> {
  const created = await bookMeeting(
    {
      scheduledStart: at(start),
      scheduledEnd: at(end),
      contexts: [{ contextType: 'case', contextId: expert.engagementId }],
    },
    log
  );
  return { meetingId: created.meeting.id, expertProfileId: created.expertProfileId };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── The round trip ───────────────────────────────────────────────────────────

describe('BAL-428 — booking a meeting removes the slot the marketplace advertises', () => {
  it('book → the slot disappears; cancel → it comes back, and each step rebuilds the cache', async () => {
    const expert = await seedBookableExpert();

    const t0 = await resolveEarliest(expert.expertProfileId);
    expect(t0).toBe(NINE_AM);

    // ── BOOK ──
    const booked = await book(expert, '09:00', '10:00');
    expect(booked.expertProfileId).toBe(expert.expertProfileId);

    // The caller's post-commit obligation was discharged, for the RIGHT expert, on the
    // RIGHT queue, with the per-expert dedupe jobId the enqueue helper documents.
    expect(mockGetQueue).toHaveBeenCalledWith(AVAILABILITY_CACHE_QUEUE);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'rebuild-availability-cache',
      { expertProfileId: expert.expertProfileId },
      expect.objectContaining({ jobId: `availability-${expert.expertProfileId}` })
    );

    // ── THE ASSERTION THE WHOLE TICKET EXISTS FOR ──
    expect(await resolveEarliest(expert.expertProfileId)).toBe('2026-09-07T10:00:00.000Z');

    // …and it is PERSISTED, not merely returned. `availability_cache` is what the expert
    // list and the profile page actually read; a resolver that computed the right answer
    // without writing it would leave the stale slot on every surface.
    const [cached] = await db
      .select()
      .from(availabilityCache)
      .where(eq(availabilityCache.expertProfileId, expert.expertProfileId));
    expect(cached?.earliestAvailableAt?.toISOString()).toBe('2026-09-07T10:00:00.000Z');

    // ── CANCEL ──
    const cancelled = await cancelMeeting(booked.meetingId, log);
    expect(cancelled.expertProfileId).toBe(expert.expertProfileId);
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);

    // Cancelling is the ONLY thing that frees a booked slot, and it frees it completely.
    expect(await resolveEarliest(expert.expertProfileId)).toBe(t0);

    // The row SURVIVES, flipped rather than deleted — it is the status filter, not a
    // delete, that hands the window back.
    const projection = await findProjectionForMeeting(booked.meetingId);
    expect(projection?.status).toBe('cancelled');
    expect(projection?.deletedAt).toBeNull();
  });

  it('reschedule MOVES the blocked window — the old hour reopens and the new one closes', async () => {
    const expert = await seedBookableExpert();
    const booked = await book(expert, '09:00', '10:00');
    expect(await resolveEarliest(expert.expertProfileId)).toBe('2026-09-07T10:00:00.000Z');

    const moved = await rescheduleMeeting(
      booked.meetingId,
      { scheduledStart: at('10:00'), scheduledEnd: at('11:00') },
      log
    );
    expect(moved.expertProfileId).toBe(expert.expertProfileId);

    // The ORIGINAL hour is free again…
    expect(await resolveEarliest(expert.expertProfileId)).toBe(NINE_AM);
    const projection = await findProjectionForMeeting(booked.meetingId);
    expect(projection?.startAt.toISOString()).toBe('2026-09-07T10:00:00.000Z');

    // …and the NEW hour is genuinely blocked. Proven by booking over the freed hour: if the
    // reschedule had only freed the old window without occupying the new one, earliest
    // would land at 10:00 here instead of 11:00.
    await book(expert, '09:00', '10:00');
    expect(await resolveEarliest(expert.expertProfileId)).toBe('2026-09-07T11:00:00.000Z');
  });

  it('soft-deleting a booking frees the slot and leaves NO drift behind', async () => {
    const expert = await seedBookableExpert();
    const booked = await book(expert, '09:00', '10:00');
    expect(await resolveEarliest(expert.expertProfileId)).toBe('2026-09-07T10:00:00.000Z');

    const deleted = await softDeleteMeeting(booked.meetingId, log);
    expect(deleted.expertProfileId).toBe(expert.expertProfileId);

    expect(await resolveEarliest(expert.expertProfileId)).toBe(NINE_AM);
    // A projection left live on a deleted meeting would keep the calendar blocked forever
    // with nothing to explain why — `findProjectionDrift` is what would report it.
    expect(await findProjectionDrift({ meetingIds: [booked.meetingId] })).toEqual([]);
  });

  it('AC #5 — an ADMIN meeting over the same window writes NOTHING and rebuilds NOBODY', async () => {
    const expert = await seedBookableExpert();
    const t0 = await resolveEarliest(expert.expertProfileId);
    vi.clearAllMocks();

    const admin = await bookMeeting(
      {
        scheduledStart: at('09:00'),
        scheduledEnd: at('10:00'),
        contexts: [{ contextType: 'admin', contextId: null }],
      },
      log
    );

    // No expert, so: no projection row, no enqueue, no change to anybody's availability.
    // An internal Balo call must not occupy a marketplace calendar.
    expect(admin.expertProfileId).toBeNull();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(
      await db.select().from(consultations).where(eq(consultations.meetingId, admin.meeting.id))
    ).toEqual([]);
    expect(await resolveEarliest(expert.expertProfileId)).toBe(t0);
  });

  it('a booking blocks ONLY its own expert — a second expert’s availability is untouched', async () => {
    // The projection is keyed on the expert resolved through the context seam. If that
    // resolution ever widened (or fell back to "any expert"), this is what would catch it.
    const booked = await seedBookableExpert();
    const bystander = await seedBookableExpert();

    await book(booked, '09:00', '10:00');

    expect(await resolveEarliest(booked.expertProfileId)).toBe('2026-09-07T10:00:00.000Z');
    expect(await resolveEarliest(bystander.expertProfileId)).toBe(NINE_AM);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});

/**
 * BAL-396 §9 — THE ACCEPT PATH, END TO END, AGAINST REAL POSTGRES.
 *
 * Every other proof in this ticket is a unit test against a mocked `calendarRepository`. This
 * is the one that proves the whole chain for real: a row in `calendar_connections` (this
 * ticket's step 1/2 schema and repository work) reaches `vendorBusyProvider.listBusyBlocks`
 * (`listBusyReadTargets`, real SQL) and the booking gate (`isWindowAvailableForExpert`)
 * answers `false` — a clean 409 — rather than throwing a 500 or silently double-booking.
 */
describe('BAL-396 §9.4 — the booking gate fails CLOSED on an unreadable calendar connection', () => {
  it('is bookable with no calendar connection at all — the merge-commit no-op, proven against real rows', async () => {
    const expert = await seedBookableExpert();

    // No `calendar_connections` row exists for this expert — `listBusyReadTargets` filters on
    // `end_user_account_id IS NOT NULL`, so it returns `[]` in real SQL and the vendor client
    // is never constructed. §9.3's rollout-seam claim, proven rather than asserted from a mock.
    await expect(
      isWindowAvailableForExpert(expert.expertProfileId, at('09:00'), at('10:00'), NOW)
    ).resolves.toBe(true);
  });

  it('is UNBOOKABLE while the connection is SYNC_PENDING — never provisioned, so unreadable', async () => {
    const expert = await seedBookableExpert();
    await calendarRepository.upsertApirocConnection({
      expertProfileId: expert.expertProfileId,
      provider: 'google',
      endUserAccountId: `eua_${randomUUID()}`,
      credentialStatus: 'SYNC_PENDING',
    });

    // Nothing about the window changed — the expert's published hours are still wide open.
    // What makes it unbookable is the unreadable connection, and ONLY that.
    await expect(
      isWindowAvailableForExpert(expert.expertProfileId, at('09:00'), at('10:00'), NOW)
    ).resolves.toBe(false);
  });

  it('is UNBOOKABLE when ACTIVE but never provisioned — zero sub-calendar rows', async () => {
    const expert = await seedBookableExpert();
    await calendarRepository.upsertApirocConnection({
      expertProfileId: expert.expertProfileId,
      provider: 'google',
      endUserAccountId: `eua_${randomUUID()}`,
      credentialStatus: 'ACTIVE',
    });

    await expect(
      isWindowAvailableForExpert(expert.expertProfileId, at('09:00'), at('10:00'), NOW)
    ).resolves.toBe(false);
  });

  it('EXPIRED and REVOKED are unreadable too', async () => {
    for (const credentialStatus of ['EXPIRED', 'REVOKED'] as const) {
      const expert = await seedBookableExpert();
      await calendarRepository.upsertApirocConnection({
        expertProfileId: expert.expertProfileId,
        provider: 'google',
        endUserAccountId: `eua_${randomUUID()}`,
        credentialStatus,
      });

      await expect(
        isWindowAvailableForExpert(expert.expertProfileId, at('09:00'), at('10:00'), NOW)
      ).resolves.toBe(false);
    }
  });

  it('an ACTIVE connection provisioned with every sub-calendar conflict-check OFF is READABLE and contributes nothing — the expert’s explicit choice, not a failure', async () => {
    const expert = await seedBookableExpert();
    const connection = await calendarRepository.upsertApirocConnection({
      expertProfileId: expert.expertProfileId,
      provider: 'google',
      endUserAccountId: `eua_${randomUUID()}`,
      credentialStatus: 'ACTIVE',
    });
    await calendarRepository.replaceSubCalendars(connection.id, [
      {
        calendarId: 'cal-primary',
        name: 'Primary',
        provider: 'google',
        isPrimary: true,
        conflictCheck: false,
      },
    ]);

    // Provisioned (a sub-calendar row exists) and ACTIVE — readable — but with no
    // conflict-checked calendar it contributes no busy blocks, per §9.4's table. Still
    // bookable, and no client-construction error either.
    await expect(
      isWindowAvailableForExpert(expert.expertProfileId, at('09:00'), at('10:00'), NOW)
    ).resolves.toBe(true);
  });
});
