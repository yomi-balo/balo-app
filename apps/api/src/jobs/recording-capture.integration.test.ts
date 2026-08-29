import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-480 (AC 2/AC 3) — THE REAP → RELEASE → REINSERT PATH, END TO END AGAINST A REAL POSTGRES.
 *
 * The unit suite (`recording-capture.test.ts`) proves the CALL SEQUENCE with everything mocked.
 * It cannot prove the claim AC 2 is actually about: that `markFailed`'s `capture_ended_at`
 * really VACATES `meeting_recording_capturing_idx` so `insertCapturing` succeeds in the SAME
 * `handleEnsure` invocation. That spans a CAS, a `coalesce`, a partial unique index and an
 * `ON CONFLICT` arbiter — only Postgres can carry it.
 *
 * ⚠ THIS FILE LIVES IN `apps/api` BUT RUNS FROM `packages/db/vitest.config.integration.ts`.
 * That config's `root` is the repo root and its `globalSetup`/`setupFiles` are absolute, so one
 * testcontainer serves both packages. `@balo/db`'s `main` is raw TypeScript
 * (`./src/index.ts`), so the `db` binding this file's `@balo/db` import resolves to is the SAME
 * module instance `setup-integration.ts` reassigns via `_setDb` — every write below lands in
 * the per-test transaction and rolls back with it. `apps/api/vitest.config.ts:22` EXCLUDES
 * `*.integration.test.ts`, so the unit job never picks this up with no database.
 *
 * ⚠ `pnpm test:integration` PASSES VACUOUSLY WITHOUT DOCKER (`passWithNoTests: true` prints
 * "No test files found" and exits 0). Check the reported test COUNT, never the exit code.
 *
 * Precedent for an `apps/api` integration test:
 * `apps/api/src/services/meetings/book-and-provision.integration.test.ts`.
 *
 * ⚠⚠ SEEDING GOES THROUGH PRODUCTION REPOSITORIES ONLY, NEVER `packages/db/src/test/factories`.
 * `apps/api/src/test/fixtures/booking-graph.ts`'s own docblock states the constraint this file
 * honours: `apps/api` cannot import `packages/db/src/test/factories/*` — they are not in
 * `@balo/db`'s `exports`, and reaching them by relative path pulls `packages/db/src/**` into
 * `apps/api`'s tsconfig program as SOURCE, failing `tsc --noEmit` with TS6059 on
 * `rootDir: "src"`. So a meeting is seeded via `meetingsRepository.create` (an `admin` context
 * needs no company/expert graph — `contextId: null`) then `markInProgress`, and a STALE
 * capturing row is produced by seeding a REAL row via `insertCapturing` (its `created_at` is
 * Postgres's own `now()`, untouched by anything below) and then overriding ONLY the global
 * `Date.now` — never the `Date` constructor itself — while `handleEnsure` runs. V8's no-arg
 * `new Date()` reads the real clock through an internal binding, not through `Date.now`, so
 * `markFailed`'s `at: new Date()` and the FRESH reinsert's `created_at` (`.defaultNow()`,
 * Postgres-side) are both untouched by the override — only `handleEnsure`'s own
 * `Date.now() - capturing.createdAt.getTime()` staleness check sees the future instant.
 */

// ── Mocks (and only these). `@balo/db` MUST stay real. ────────────────────────

const MockUnrecoverableError = vi.hoisted(
  () =>
    class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'UnrecoverableError';
      }
    }
);

const wired = vi.hoisted(
  () =>
    ({ processor: undefined }) as {
      processor?: (job: unknown) => Promise<void>;
    }
);

const WorkerMock = vi.hoisted(() =>
  vi.fn(function (_queue: string, processor: (job: unknown) => Promise<void>) {
    wired.processor = processor;
    return { on: vi.fn() };
  })
);

const { mockStartRoomRecording, mockStopRoomRecording } = vi.hoisted(() => ({
  mockStartRoomRecording: vi.fn().mockResolvedValue(undefined),
  mockStopRoomRecording: vi.fn().mockResolvedValue('stopped'),
}));

const mockTrackServer = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({ Worker: WorkerMock, UnrecoverableError: MockUnrecoverableError }));
// `getRedis()` throws without `REDIS_URL` — never let the real module load.
vi.mock('../lib/queue.js', () => ({ getQueue: () => ({ add: vi.fn() }) }));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn(() => ({})) }));
// ⚠ ALL THREE EXPORTS — a vitest factory mock throws on any export the import graph touches
// but the factory omits. `MIN_IDLE_TIMEOUT_SECONDS` is the same trap §10.10 names for the unit
// suite's Daily mock.
vi.mock('../services/daily/recordings.js', () => ({
  startRoomRecording: mockStartRoomRecording,
  stopRoomRecording: mockStopRoomRecording,
  MIN_IDLE_TIMEOUT_SECONDS: 60,
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  RECORDING_SERVER_EVENTS: {
    RECORDING_STARTED: 'recording_started',
    RECORDING_READY: 'recording_ready',
    RECORDING_FAILED: 'recording_failed',
  },
}));

import {
  meetingPresenceRepository,
  meetingRecordingsRepository,
  meetingsRepository,
  type MeetingRecording,
} from '@balo/db';
import {
  MAX_DAILY_FAILURES_PER_MEETING,
  STUCK_CAPTURE_THRESHOLD_MS,
  startRecordingCaptureWorker,
} from './recording-capture.js';

const SCHEDULED_START = new Date('2026-01-01T10:00:00.000Z');
const SCHEDULED_END = new Date('2026-01-01T11:00:00.000Z');

async function runEnsure(meetingId: string): Promise<void> {
  startRecordingCaptureWorker();
  await wired.processor?.({ name: 'ensure', data: { meetingId, trigger: 'sweep' } });
}

/** A per-test unique Daily-shaped room name — `meeting_daily_room_name_idx` is unique. */
function freshRoomName(): string {
  return `balo-${randomUUID().replace(/-/g, '')}`;
}

/**
 * A live, occupied, `in_progress` meeting — seeded through the SAME production repositories a
 * real caller uses (`create` → `markInProgress`), never a schema-level factory. `admin` needs
 * no company/expert graph (`contextId: null` is legal by the CHECK) and resolves no expert, so
 * it projects nothing and blocks nobody's calendar — irrelevant to what this file proves.
 */
async function seedOccupiedInProgressMeeting(): Promise<string> {
  const { meeting } = await meetingsRepository.create({
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
    contexts: [{ contextType: 'admin', contextId: null }],
    dailyRoomName: freshRoomName(),
    joinUrl: 'https://balo.daily.co/test-room',
  });
  const started = await meetingsRepository.markInProgress(meeting.id, new Date());
  if (started === undefined) {
    throw new Error('failed to transition the seeded meeting to in_progress');
  }
  // A presence interval with BOTH identities null is legal by design
  // (`meeting_presence_identity_not_both` is "at most one") — the cheapest way to satisfy
  // `handleEnsure` step 4 (room not empty) without a user/guest graph.
  await meetingPresenceRepository.open({
    meetingId: meeting.id,
    userId: null,
    meetingGuestId: null,
    party: 'observer',
  });
  return meeting.id;
}

/** Mints ONE real `recording` row via the production `insertCapturing` mutator. */
async function seedCapturingRow(meetingId: string): Promise<MeetingRecording> {
  const row = await meetingRecordingsRepository.insertCapturing({ meetingId });
  if (row === undefined) {
    throw new Error('failed to seed a capturing row — the slot was already taken');
  }
  return row;
}

/** One full `insertCapturing` → `markFailed` cycle — a real `failed` row at stage `daily`. */
async function seedFailedDailyRow(meetingId: string): Promise<void> {
  const row = await seedCapturingRow(meetingId);
  const failed = await meetingRecordingsRepository.markFailed({
    id: row.id,
    stage: 'daily',
    reason: 'seed: simulated Daily start failure',
    at: new Date(),
  });
  if (failed === undefined) {
    throw new Error('failed to seed a failed row');
  }
}

/**
 * Runs `fn` with the global `Date.now` overridden to `futureMs`, restoring it afterwards —
 * never the `Date` constructor itself. See the module docblock for why this is safe against
 * Postgres's own `.defaultNow()` timestamps and against `new Date()` elsewhere in the handler.
 */
async function withFutureNow<T>(futureMs: number, fn: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => futureMs;
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartRoomRecording.mockResolvedValue(undefined);
  mockStopRoomRecording.mockResolvedValue('stopped');
});

describe('BAL-480 — the stuck-slot reap, against a real database', () => {
  it('AC 2 — reaps the stuck row, releases the slot, and reinserts a fresh segment in ONE invocation', async () => {
    const meetingId = await seedOccupiedInProgressMeeting();
    const stuck = await seedCapturingRow(meetingId);
    const futureNow = stuck.createdAt.getTime() + STUCK_CAPTURE_THRESHOLD_MS + 60_000;

    await withFutureNow(futureNow, () => runEnsure(meetingId));

    // 1. The stuck row really was reaped — `failed`, at stage `daily`, with the slot released.
    const reaped = await meetingRecordingsRepository.findById(stuck.id);
    expect(reaped?.status).toBe('failed');
    expect(reaped?.failedStage).toBe('daily');
    expect(reaped?.failureReason).toContain('stuck');
    expect(reaped?.captureEndedAt).toBeInstanceOf(Date);

    // 2. The reinsert really WON against the live partial unique index — a DIFFERENT row is now
    // the meeting's capturing segment.
    const fresh = await meetingRecordingsRepository.findCapturingForMeeting(meetingId);
    expect(fresh).toBeDefined();
    expect(fresh?.id).not.toBe(stuck.id);
    expect(fresh?.status).toBe('recording');
    expect(fresh?.captureEndedAt).toBeNull();

    // 3. Both segments exist on the meeting's list.
    const all = await meetingRecordingsRepository.listByMeeting(meetingId);
    expect(all).toHaveLength(2);

    // 4. Daily was asked to start a NEW capture, keyed on the fresh row's id.
    expect(mockStartRoomRecording).toHaveBeenCalledTimes(1);
    const [, startArgs] = mockStartRoomRecording.mock.calls[0] as [string, { instanceId: string }];
    expect(startArgs.instanceId).toBe(fresh?.id);

    // 5. Analytics: exactly one reap emit, plus the clean-path start emit.
    expect(mockTrackServer).toHaveBeenCalledWith('recording_failed', {
      meeting_id: meetingId,
      stage: 'daily',
      reason: 'stuck_capture',
      distinct_id: meetingId,
    });
    expect(mockTrackServer).toHaveBeenCalledWith(
      'recording_started',
      expect.objectContaining({ meeting_id: meetingId, trigger: 'sweep' })
    );
  });

  it('AC 3 — the cap holds on the real table: the slot frees but no fresh capture starts', async () => {
    const meetingId = await seedOccupiedInProgressMeeting();
    // Fills the SAME budget the reap will contribute to — one cycle per allowance unit, each
    // taking and releasing the slot exactly as a real Daily start failure would.
    for (let i = 0; i < MAX_DAILY_FAILURES_PER_MEETING; i += 1) {
      await seedFailedDailyRow(meetingId);
    }
    const stuck = await seedCapturingRow(meetingId);
    const futureNow = stuck.createdAt.getTime() + STUCK_CAPTURE_THRESHOLD_MS + 60_000;

    await withFutureNow(futureNow, () => runEnsure(meetingId));

    // The reap still happens — the slot is freed regardless of the cap.
    const reaped = await meetingRecordingsRepository.findById(stuck.id);
    expect(reaped?.status).toBe('failed');

    // But the cap refuses the reinsert: no capturing row, no Daily call.
    const capturing = await meetingRecordingsRepository.findCapturingForMeeting(meetingId);
    expect(capturing).toBeUndefined();
    expect(mockStartRoomRecording).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ FIX ROUND 1 — THE TOCTOU, ON THE REAL CAS. The reap decides "stuck" from the row read at
   * step 5, but `markStarted` does NOT move `status`, so the base CAS (`status <> 'ready' AND
   * status <> 'failed'`) is BLIND to a `recording.started` that commits inside that window — and
   * a 5-minute threshold selects precisely for LATE deliveries. Without `onlyIfUnacknowledged`
   * this write WINS: a row that HAS a Daily id is marked `failed`, its slot is released, and the
   * same invocation starts a SECOND Daily recording in the same room — two concurrent captures,
   * both billing — while the first one's `ready-to-download` is then refused by
   * `markSourceReady`'s `status = 'recording'` CAS and lost.
   *
   * ⚠ THE INTERLEAVING IS PRODUCED BY A SPY, NOT BY TWO CONNECTIONS, and it has to be: this
   * harness runs every test on a SINGLE (`max: 1`) connection inside one transaction, so genuine
   * concurrency is inexpressible here — that is what
   * `packages/db/src/repositories/meeting-recordings.concurrency.integration.test.ts` exists
   * for. Calling through `findCapturingForMeeting` and THEN committing the acknowledgement
   * places the late write at exactly the instant the race would (after the staleness read,
   * before the reap write), which is the only ordering the guard cares about. Everything
   * downstream is real: a real CAS, a real partial unique index, a real `ON CONFLICT` arbiter.
   */
  it('⚠⚠ a LATE recording.started makes the reap LOSE — no reap, no reinsert, no second Daily start', async () => {
    const meetingId = await seedOccupiedInProgressMeeting();
    const stuck = await seedCapturingRow(meetingId);
    const futureNow = stuck.createdAt.getTime() + STUCK_CAPTURE_THRESHOLD_MS + 60_000;

    const readSpy = vi
      .spyOn(meetingRecordingsRepository, 'findCapturingForMeeting')
      .mockImplementation(async (id: string) => {
        // Restore FIRST so the call-through below is the real read, not this mock again.
        readSpy.mockRestore();
        const row = await meetingRecordingsRepository.findCapturingForMeeting(id);
        // The dropped `recording.started` finally lands — INSIDE the window.
        const acknowledged = await meetingRecordingsRepository.markStarted({
          id: stuck.id,
          dailyRecordingId: 'daily-late-1',
          startedAt: new Date(),
        });
        expect(acknowledged).toBeDefined();
        return row;
      });

    try {
      await withFutureNow(futureNow, () => runEnsure(meetingId));
    } finally {
      readSpy.mockRestore();
    }

    // 1. The live segment survived: still `recording`, still holding its slot, Daily id intact.
    const survivor = await meetingRecordingsRepository.findById(stuck.id);
    expect(survivor?.status).toBe('recording');
    expect(survivor?.dailyRecordingId).toBe('daily-late-1');
    expect(survivor?.captureEndedAt).toBeNull();

    // 2. NO fresh segment — the fall-through insert lost the partial unique index cleanly.
    const all = await meetingRecordingsRepository.listByMeeting(meetingId);
    expect(all).toHaveLength(1);

    // 3. ⚠ THE PROPERTY THAT COSTS MONEY: Daily was never asked to start a second recording.
    expect(mockStartRoomRecording).not.toHaveBeenCalled();

    // 4. Nothing was reaped, so nothing is reported as reaped.
    expect(mockTrackServer).not.toHaveBeenCalledWith('recording_failed', expect.anything());
  });

  it('a non-stuck (young) capturing row is untouched — no reap, no reinsert', async () => {
    const meetingId = await seedOccupiedInProgressMeeting();
    const fresh = await seedCapturingRow(meetingId);

    // No `Date.now` override — real "now" minus a just-inserted row's `created_at` is well
    // under the threshold.
    await runEnsure(meetingId);

    const row = await meetingRecordingsRepository.findById(fresh.id);
    expect(row?.status).toBe('recording');
    expect(row?.captureEndedAt).toBeNull();

    const all = await meetingRecordingsRepository.listByMeeting(meetingId);
    expect(all).toHaveLength(1);
    expect(mockStartRoomRecording).not.toHaveBeenCalled();
  });
});
