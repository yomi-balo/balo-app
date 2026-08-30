import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { meetingRecordings } from '../schema';
import type { NewMeetingRecording } from '../schema';
import { meetingFactory, meetingRecordingFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  meetingRecordingsRepository,
  MEETING_RECORDING_LIST_LIMIT,
  FAILURE_REASON_MAX_LENGTH,
} from './meeting-recordings';

/**
 * BAL-473 — `meeting_recordings`, the recording state machine's only writer.
 *
 * ⚠ SEVERAL TESTS BELOW END ON A REJECTED REPOSITORY CALL AND NOTHING FOLLOWS IT. That is
 * deliberate, and it is the `meeting-files.integration.test.ts` discipline: the harness holds
 * each test inside ONE outer transaction, so a statement that fails on the module-level `db`
 * ABORTS it and every later statement answers `25P02` instead of the code under assertion.
 * RAW probes go through `expectConstraintViolation`, which runs them on their own SAVEPOINT;
 * REPOSITORY probes cannot (the repository writes through the module-level `db`), so each is
 * the LAST statement of its own `it`.
 *
 * ⚠ THE HARNESS `db` **IS** THE PER-TEST TRANSACTION, so it also satisfies the `DbExecutor`
 * that `markSourceReady` and `markReady` demand. That is not a loophole — those two require an
 * executor so a PRODUCTION caller cannot pass the base client by omission and commit an effect
 * outside its webhook marker's transaction; a test handing over the transaction it is already
 * inside is exactly the intended usage.
 *
 * ⚠ GENUINE CONCURRENCY IS NOT EXPRESSIBLE HERE — the harness runs every test on a single
 * (`max: 1`) connection inside one open transaction, so two "simultaneous" calls can only ever
 * run sequentially. The "a concurrent duplicate loses the unique index" acceptance criterion
 * lives in `meeting-recordings.concurrency.integration.test.ts`, on its own backends.
 */

/** A fresh, collision-proof vendor-shaped id. */
function vendorId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** A raw row payload — for the probes that must bypass the repository's types entirely. */
function rawRow(
  meetingId: string,
  overrides: Partial<NewMeetingRecording> = {}
): NewMeetingRecording {
  return { meetingId, ...overrides };
}

// ── 1. insertCapturing ───────────────────────────────────────────────────────

describe('meetingRecordingsRepository.insertCapturing', () => {
  it('mints a segment at status=recording with the capture slot TAKEN', async () => {
    const { meeting } = await meetingFactory();

    const row = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });

    expect(row).toBeDefined();
    expect(row?.meetingId).toBe(meeting.id);
    // The column default, not a value the repository passes — pinned so a schema change surfaces.
    expect(row?.status).toBe('recording');
    // ⚠ NULL IS WHAT HOLDS THE SLOT. Every other assertion in this file about the capture slot
    // depends on this one being true at insert.
    expect(row?.captureEndedAt).toBeNull();
    // The row EXISTS BEFORE EITHER VENDOR HAS AN ID — the whole reason both are nullable.
    expect(row?.dailyRecordingId).toBeNull();
    expect(row?.muxAssetId).toBeNull();
    expect(row?.muxPlaybackId).toBeNull();
    expect(row?.startedAt).toBeNull();
    expect(row?.readyAt).toBeNull();
    expect(row?.sourceDeletedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
  });

  it('THE CAPTURE SLOT: a second insert for the same meeting returns undefined and writes nothing', async () => {
    const { meeting } = await meetingFactory();

    const first = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });
    expect(first).toBeDefined();

    // This is the concurrent-duplicate `recording-ensure` case, reached sequentially. The raw
    // 23505 on `meeting_recording_capturing_idx` is caught and mapped to `undefined` — a
    // SUCCESSFUL no-op meaning "somebody else is already capturing", never an error. The loser
    // must not go on to start a second Daily recording in the same room.
    const duplicate = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });
    expect(duplicate).toBeUndefined();

    const rows = await db
      .select()
      .from(meetingRecordings)
      .where(eq(meetingRecordings.meetingId, meeting.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
  });

  it('⚠⚠ THE 1:n REJOIN AC: a fresh segment inserts once markSourceReady has released the slot', async () => {
    const { meeting } = await meetingFactory();

    const first = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });
    if (first === undefined) throw new Error('expected the first segment to insert');

    // Daily auto-stopped on `minIdleTimeOut` and `ready-to-download` landed. Stamping
    // `capture_ended_at` is what VACATES the partial unique.
    const settled = await meetingRecordingsRepository.markSourceReady(
      { id: first.id, durationSeconds: 120, at: new Date() },
      db
    );
    expect(settled?.captureEndedAt).toBeInstanceOf(Date);

    // …and the rejoin's `recording-ensure` now inserts a SECOND segment rather than no-opping.
    // D2: a meeting has 1:n segments in start order; that is the truth, not a defect to collapse.
    const second = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });
    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first.id);
    expect(second?.status).toBe('recording');

    const all = await meetingRecordingsRepository.listByMeeting(meeting.id);
    expect(all).toHaveLength(2);
  });

  it('a failed segment also frees the slot — which is what makes the ensure RETRY work (§5.1b)', async () => {
    const { meeting } = await meetingFactory();
    const first = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });
    if (first === undefined) throw new Error('expected the first segment to insert');

    // T5: the ensure job's own `recordings/start` call failed, so it stamps the row `failed`
    // BEFORE rethrowing. Leaving it at `recording` would wedge the meeting forever.
    await meetingRecordingsRepository.markFailed(
      { id: first.id, stage: 'daily', reason: 'start call failed', at: new Date() },
      db
    );

    // The BullMQ retry re-enters the ensure and gets a FRESH row with a FRESH instanceId.
    const retry = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });
    expect(retry).toBeDefined();
    expect(retry?.id).not.toBe(first.id);
  });

  it('different meetings never contend — the slot is per meeting, not global', async () => {
    const a = await meetingFactory();
    const b = await meetingFactory();

    const first = await meetingRecordingsRepository.insertCapturing({ meetingId: a.meeting.id });
    const second = await meetingRecordingsRepository.insertCapturing({ meetingId: b.meeting.id });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first?.id);
  });

  it('a 23503 on an unknown meeting propagates RAW — a job for a nonexistent meeting is a bug, not a race', async () => {
    // Deliberately NOT swallowed: only the capturing-index 23505 is mapped to `undefined`.
    await expectConstraintViolation('23503', (tx) =>
      tx.insert(meetingRecordings).values(rawRow(randomUUID()))
    );
  });
});

// ── 2. The CHECK backstops ───────────────────────────────────────────────────

describe('meeting_recordings — the CHECK constraints', () => {
  it('meeting_recording_capture_slot rejects a raw non-recording row with capture_ended_at NULL', async () => {
    const { meeting } = await meetingFactory();

    // ⚠ THE INVARIANT THAT KEEPS THE CAPTURE SLOT MEANINGFUL. A `ready` or `failed` row still
    // holding its meeting's slot would make every future `recording-ensure` for that meeting a
    // silent no-op FOREVER. The repository can never produce this state (every terminal
    // mutator stamps `capture_ended_at`); the CHECK is the backstop against a raw writer.
    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(meetingRecordings)
        .values(rawRow(meeting.id, { status: 'ready', captureEndedAt: null }))
    );
  });

  it('meeting_recording_capture_slot ALLOWS a settled row (the other direction is unconstrained)', async () => {
    const { meeting } = await meetingFactory();

    // One-directional by design: `capture_ended_at IS NOT NULL OR status = 'recording'`. A
    // stamped `recording` row is legal — it is the instant between Daily stopping and
    // `ready-to-download` landing — so the CHECK must NOT reject it.
    const [row] = await db
      .insert(meetingRecordings)
      .values(rawRow(meeting.id, { status: 'recording', captureEndedAt: new Date() }))
      .returning();
    expect(row?.status).toBe('recording');
    expect(row?.captureEndedAt).toBeInstanceOf(Date);
  });

  it('meeting_recording_duration_non_negative rejects a negative duration but allows NULL and 0', async () => {
    const { meeting } = await meetingFactory();

    const [nullDuration] = await db
      .insert(meetingRecordings)
      .values(rawRow(meeting.id, { durationSeconds: null }))
      .returning();
    expect(nullDuration?.durationSeconds).toBeNull();

    const other = await meetingFactory();
    const [zeroDuration] = await db
      .insert(meetingRecordings)
      .values(rawRow(other.meeting.id, { durationSeconds: 0 }))
      .returning();
    expect(zeroDuration?.durationSeconds).toBe(0);

    const third = await meetingFactory();
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingRecordings).values(rawRow(third.meeting.id, { durationSeconds: -1 }))
    );
  });
});

// ── 3. The reads ─────────────────────────────────────────────────────────────

describe('meetingRecordingsRepository — the reads', () => {
  it('findById returns a live segment and hides a soft-deleted one', async () => {
    const { recording } = await meetingRecordingFactory();

    expect((await meetingRecordingsRepository.findById(recording.id))?.id).toBe(recording.id);
    expect(await meetingRecordingsRepository.findById(randomUUID())).toBeUndefined();

    await meetingRecordingsRepository.softDelete({ id: recording.id });
    expect(await meetingRecordingsRepository.findById(recording.id)).toBeUndefined();
  });

  it('findCapturingForMeeting finds the unsettled segment and nothing once it settles', async () => {
    const { meeting } = await meetingFactory();
    const capturing = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });
    if (capturing === undefined) throw new Error('expected a capturing segment');

    expect((await meetingRecordingsRepository.findCapturingForMeeting(meeting.id))?.id).toBe(
      capturing.id
    );

    // Predicated on the TIMESTAMP, not on `status` — the timestamp is what the unique index
    // reads, so it is the authority.
    await meetingRecordingsRepository.markSourceReady({ id: capturing.id, at: new Date() }, db);
    expect(await meetingRecordingsRepository.findCapturingForMeeting(meeting.id)).toBeUndefined();
  });

  it('findByDailyRecordingId and findByMuxAssetId resolve the segment the webhooks key on', async () => {
    const dailyId = vendorId('rec');
    const assetId = vendorId('asset');
    const { recording } = await meetingRecordingFactory({
      status: 'ingesting',
      dailyRecordingId: dailyId,
      muxAssetId: assetId,
    });

    expect((await meetingRecordingsRepository.findByDailyRecordingId(dailyId))?.id).toBe(
      recording.id
    );
    expect((await meetingRecordingsRepository.findByMuxAssetId(assetId))?.id).toBe(recording.id);

    expect(
      await meetingRecordingsRepository.findByDailyRecordingId(vendorId('rec'))
    ).toBeUndefined();
    expect(await meetingRecordingsRepository.findByMuxAssetId(vendorId('asset'))).toBeUndefined();
  });

  it('⚠ A SOFT-DELETE FREES BOTH THE CAPTURE SLOT AND THE VENDOR IDS (both uniques are partial)', async () => {
    const { meeting } = await meetingFactory();
    const dailyId = vendorId('rec');
    const assetId = vendorId('asset');
    const { recording } = await meetingRecordingFactory({
      meetingId: meeting.id,
      status: 'recording',
      dailyRecordingId: dailyId,
      muxAssetId: assetId,
    });

    await meetingRecordingsRepository.softDelete({ id: recording.id });

    // Invisible to every read…
    expect(await meetingRecordingsRepository.findByDailyRecordingId(dailyId)).toBeUndefined();
    expect(await meetingRecordingsRepository.findByMuxAssetId(assetId)).toBeUndefined();
    expect(await meetingRecordingsRepository.findCapturingForMeeting(meeting.id)).toBeUndefined();

    // …and BOTH vendor ids plus the capture slot are genuinely re-usable. This is the ops
    // escape hatch for a row stuck at `recording`: there is deliberately no reaper, so
    // soft-deleting by hand is how the meeting is un-wedged.
    const revived = await meetingRecordingsRepository.insertCapturing({ meetingId: meeting.id });
    expect(revived).toBeDefined();

    const [reused] = await db
      .insert(meetingRecordings)
      .values(
        rawRow((await meetingFactory()).meeting.id, {
          dailyRecordingId: dailyId,
          muxAssetId: assetId,
        })
      )
      .returning();
    expect(reused?.dailyRecordingId).toBe(dailyId);
  });

  it('listByMeeting returns live segments OLDEST FIRST and excludes soft-deleted ones', async () => {
    const { meeting } = await meetingFactory();

    // Seeded settled so each release frees the slot for the next — a real rejoin sequence.
    const first = await meetingRecordingFactory({ meetingId: meeting.id, status: 'ready' });
    const second = await meetingRecordingFactory({ meetingId: meeting.id, status: 'failed' });
    const third = await meetingRecordingFactory({ meetingId: meeting.id, status: 'recording' });

    const listed = await meetingRecordingsRepository.listByMeeting(meeting.id);
    // START ORDER (D2) — BAL-440 renders them in the order they were captured. Ordered by
    // `created_at`, NOT `started_at`, which stays NULL when `recording.started` is dropped.
    expect(listed.map((row) => row.id)).toEqual([
      first.recording.id,
      second.recording.id,
      third.recording.id,
    ]);

    await meetingRecordingsRepository.softDelete({ id: second.recording.id });
    expect((await meetingRecordingsRepository.listByMeeting(meeting.id)).map((r) => r.id)).toEqual([
      first.recording.id,
      third.recording.id,
    ]);
  });

  it('listByMeeting is BOUNDED at MEETING_RECORDING_LIST_LIMIT (a cap, not pagination)', async () => {
    const { meeting } = await meetingFactory();
    const overCap = MEETING_RECORDING_LIST_LIMIT + 3;

    // Inserted raw and pre-settled: `insertCapturing` could only ever produce one at a time,
    // and the point here is the LIMIT clause, not the slot.
    await db
      .insert(meetingRecordings)
      .values(
        Array.from({ length: overCap }, () =>
          rawRow(meeting.id, { status: 'ready', captureEndedAt: new Date() })
        )
      );

    const listed = await meetingRecordingsRepository.listByMeeting(meeting.id);
    expect(listed).toHaveLength(MEETING_RECORDING_LIST_LIMIT);
  });

  it('listByMeeting returns an empty array for a meeting with no segments', async () => {
    const { meeting } = await meetingFactory();
    expect(await meetingRecordingsRepository.listByMeeting(meeting.id)).toEqual([]);
  });
});

// ── 3b. countFailedByStage (FIX ROUND 2, R2 circuit breaker) ─────────────────

describe('meetingRecordingsRepository.countFailedByStage', () => {
  it('counts only LIVE failed segments at the given stage', async () => {
    const { meeting } = await meetingFactory();
    await meetingRecordingFactory({
      meetingId: meeting.id,
      status: 'failed',
      failedStage: 'daily',
    });
    await meetingRecordingFactory({
      meetingId: meeting.id,
      status: 'failed',
      failedStage: 'daily',
    });
    // A different stage must not be counted.
    await meetingRecordingFactory({
      meetingId: meeting.id,
      status: 'failed',
      failedStage: 'mux_ingest',
    });
    // A non-failed segment must not be counted.
    await meetingRecordingFactory({ meetingId: meeting.id, status: 'ready' });

    expect(await meetingRecordingsRepository.countFailedByStage(meeting.id, 'daily')).toBe(2);
    expect(await meetingRecordingsRepository.countFailedByStage(meeting.id, 'mux_ingest')).toBe(1);
  });

  it('excludes a soft-deleted failure', async () => {
    const { meeting } = await meetingFactory();
    const { recording } = await meetingRecordingFactory({
      meetingId: meeting.id,
      status: 'failed',
      failedStage: 'daily',
    });
    await meetingRecordingsRepository.softDelete({ id: recording.id });

    expect(await meetingRecordingsRepository.countFailedByStage(meeting.id, 'daily')).toBe(0);
  });

  it('returns 0 for a meeting with no failures at all', async () => {
    const { meeting } = await meetingFactory();
    expect(await meetingRecordingsRepository.countFailedByStage(meeting.id, 'daily')).toBe(0);
  });

  it('different meetings never contend — the count is per meeting', async () => {
    const a = await meetingFactory();
    const b = await meetingFactory();
    await meetingRecordingFactory({
      meetingId: a.meeting.id,
      status: 'failed',
      failedStage: 'daily',
    });

    expect(await meetingRecordingsRepository.countFailedByStage(a.meeting.id, 'daily')).toBe(1);
    expect(await meetingRecordingsRepository.countFailedByStage(b.meeting.id, 'daily')).toBe(0);
  });
});

// ── 3c. findInMeeting (BAL-440 — the ONLY client-reachable read) ─────────────

describe('meetingRecordingsRepository.findInMeeting', () => {
  it('returns the segment when the meeting AND the recording id both match', async () => {
    const assetId = vendorId('asset');
    const { meetingId, recording } = await meetingRecordingFactory({
      status: 'ready',
      muxAssetId: assetId,
      muxPlaybackId: vendorId('pb'),
      readyAt: new Date(),
      durationSeconds: 2712,
    });

    const found = await meetingRecordingsRepository.findInMeeting({
      meetingId,
      recordingId: recording.id,
    });

    expect(found?.id).toBe(recording.id);
    expect(found?.meetingId).toBe(meetingId);
    // ⚠ THE FULL ROW CROSSES THIS SEAM, `mux_asset_id` INCLUDED — pinned deliberately. The
    // repository does not project; `toMeetingRecordingView` (`@balo/shared/meetings`) is the
    // concealment boundary and it is the WEB caller's obligation, not this layer's. A future
    // change that starts projecting here would break that division silently.
    expect(found?.muxAssetId).toBe(assetId);
    expect(found?.durationSeconds).toBe(2712);
  });

  it('⚠⚠ THE IDOR PROOF: a recording that EXISTS but under a DIFFERENT meeting is undefined', async () => {
    // The recording the attacker names — real, live, `ready`, and none of their business.
    const other = await meetingRecordingFactory({ status: 'ready', readyAt: new Date() });
    // The meeting they were actually authorized for.
    const { meeting: authorized } = await meetingFactory();

    // The row genuinely exists — so `undefined` below cannot be read as "seeded nothing".
    expect((await meetingRecordingsRepository.findById(other.recording.id))?.id).toBe(
      other.recording.id
    );
    expect(other.meetingId).not.toBe(authorized.id);

    // Scoped by the GATE'S meeting, the foreign id resolves to exactly what a nonexistent one
    // does. This is the whole reason `findInMeeting` exists rather than a bare `findById`.
    expect(
      await meetingRecordingsRepository.findInMeeting({
        meetingId: authorized.id,
        recordingId: other.recording.id,
      })
    ).toBeUndefined();
  });

  it('a soft-deleted segment is invisible even to its OWN meeting', async () => {
    const { meetingId, recording } = await meetingRecordingFactory({
      status: 'ready',
      readyAt: new Date(),
    });

    expect(
      (await meetingRecordingsRepository.findInMeeting({ meetingId, recordingId: recording.id }))
        ?.id
    ).toBe(recording.id);

    await meetingRecordingsRepository.softDelete({ id: recording.id });

    // `deleted_at IS NULL` is a term in the WHERE clause, not a post-filter — the repository
    // convention, and what keeps a deleted segment out of the playback mint.
    expect(
      await meetingRecordingsRepository.findInMeeting({ meetingId, recordingId: recording.id })
    ).toBeUndefined();
  });

  it('an unknown recordingId is undefined — the SAME answer a foreign one gets, so probing teaches nothing', async () => {
    const { meeting } = await meetingFactory();

    expect(
      await meetingRecordingsRepository.findInMeeting({
        meetingId: meeting.id,
        recordingId: randomUUID(),
      })
    ).toBeUndefined();
  });
});

// ── 4. markStarted (T2) ──────────────────────────────────────────────────────

describe('meetingRecordingsRepository.markStarted', () => {
  it('stamps the Daily id and start instant WITHOUT moving the status', async () => {
    const { recording } = await meetingRecordingFactory();
    const dailyId = vendorId('rec');
    const startedAt = new Date('2026-08-25T10:00:00.000Z');

    const updated = await meetingRecordingsRepository.markStarted(
      { id: recording.id, dailyRecordingId: dailyId, startedAt },
      db
    );

    expect(updated?.dailyRecordingId).toBe(dailyId);
    expect(updated?.startedAt?.toISOString()).toBe(startedAt.toISOString());
    // ⚠ The segment was ALREADY `recording` the moment we inserted it. `recording.started`
    // only teaches us Daily's id — it is not a transition.
    expect(updated?.status).toBe('recording');
    expect(updated?.captureEndedAt).toBeNull();
  });

  it('THE REPLAY: a second delivery finds daily_recording_id already set and returns undefined', async () => {
    const { recording } = await meetingRecordingFactory();
    await meetingRecordingsRepository.markStarted(
      { id: recording.id, dailyRecordingId: vendorId('rec'), startedAt: new Date() },
      db
    );

    const replay = await meetingRecordingsRepository.markStarted(
      { id: recording.id, dailyRecordingId: vendorId('rec-other'), startedAt: new Date() },
      db
    );
    expect(replay).toBeUndefined();
  });

  it('⚠ REFUSES A FAILED ROW — reviving it would break the capture slot (the T5 residual)', async () => {
    const { recording } = await meetingRecordingFactory({
      status: 'failed',
      failedStage: 'daily',
    });

    // A `failed` row has `capture_ended_at` stamped. Moving it back to a capturing state would
    // put a `recording` row OUTSIDE the slot and let a second Daily recording run in parallel.
    // The caller logs at `error`: an unattached Daily recording exists, and auto-stops on idle.
    const refused = await meetingRecordingsRepository.markStarted(
      { id: recording.id, dailyRecordingId: vendorId('rec'), startedAt: new Date() },
      db
    );
    expect(refused).toBeUndefined();
  });

  it('refuses a soft-deleted row', async () => {
    const { recording } = await meetingRecordingFactory();
    await meetingRecordingsRepository.softDelete({ id: recording.id });

    const refused = await meetingRecordingsRepository.markStarted(
      { id: recording.id, dailyRecordingId: vendorId('rec'), startedAt: new Date() },
      db
    );
    expect(refused).toBeUndefined();
  });
});

// ── 5. markSourceReady (T3) ──────────────────────────────────────────────────

describe('meetingRecordingsRepository.markSourceReady', () => {
  it('transitions to source_ready, RELEASES the capture slot, and records the duration', async () => {
    const { recording } = await meetingRecordingFactory();
    const at = new Date('2026-08-25T11:00:00.000Z');

    const updated = await meetingRecordingsRepository.markSourceReady(
      { id: recording.id, durationSeconds: 930, at },
      db
    );

    expect(updated?.status).toBe('source_ready');
    expect(updated?.captureEndedAt?.toISOString()).toBe(at.toISOString());
    expect(updated?.durationSeconds).toBe(930);
  });

  it('COALESCE: backfills the Daily id and start instant when the row has neither (a dropped recording.started)', async () => {
    const { recording } = await meetingRecordingFactory();
    expect(recording.dailyRecordingId).toBeNull();

    const dailyId = vendorId('rec');
    const startedAt = new Date('2026-08-25T10:30:00.000Z');
    const updated = await meetingRecordingsRepository.markSourceReady(
      {
        id: recording.id,
        dailyRecordingId: dailyId,
        startedAt,
        durationSeconds: 60,
        at: new Date(),
      },
      db
    );

    // This is what makes a dropped `recording.started` cost nothing.
    expect(updated?.dailyRecordingId).toBe(dailyId);
    expect(updated?.startedAt?.toISOString()).toBe(startedAt.toISOString());
  });

  it('COALESCE: the INCUMBENT Daily id and start instant WIN when recording.started already landed', async () => {
    const { recording } = await meetingRecordingFactory();
    const originalId = vendorId('rec-original');
    const originalStart = new Date('2026-08-25T10:00:00.000Z');
    await meetingRecordingsRepository.markStarted(
      { id: recording.id, dailyRecordingId: originalId, startedAt: originalStart },
      db
    );

    const updated = await meetingRecordingsRepository.markSourceReady(
      {
        id: recording.id,
        dailyRecordingId: vendorId('rec-later'),
        startedAt: new Date('2026-08-25T12:00:00.000Z'),
        at: new Date(),
      },
      db
    );

    // The earlier event is the more authoritative one — it named the capture's real start.
    expect(updated?.dailyRecordingId).toBe(originalId);
    expect(updated?.startedAt?.toISOString()).toBe(originalStart.toISOString());
  });

  it('accepts a null duration — Daily’s `duration` field is unverified (plan §18 item 19)', async () => {
    const { recording } = await meetingRecordingFactory();

    const updated = await meetingRecordingsRepository.markSourceReady(
      { id: recording.id, durationSeconds: null, at: new Date() },
      db
    );
    // Mux's duration overwrites this on `ready` anyway, so the feature does not depend on it.
    expect(updated?.status).toBe('source_ready');
    expect(updated?.durationSeconds).toBeNull();
  });

  it('THE REPLAY: a second delivery finds status=source_ready and returns undefined', async () => {
    const { recording } = await meetingRecordingFactory();
    const at = new Date('2026-08-25T11:00:00.000Z');
    await meetingRecordingsRepository.markSourceReady({ id: recording.id, at }, db);

    const replay = await meetingRecordingsRepository.markSourceReady(
      { id: recording.id, at: new Date('2026-08-25T13:00:00.000Z') },
      db
    );
    expect(replay).toBeUndefined();

    // The original release instant survives — a replay must not rewrite history.
    const row = await meetingRecordingsRepository.findById(recording.id);
    expect(row?.captureEndedAt?.toISOString()).toBe(at.toISOString());
  });
});

// ── 6. markIngesting (T6) ────────────────────────────────────────────────────

describe('meetingRecordingsRepository.markIngesting', () => {
  it('stamps the Mux asset id and moves source_ready → ingesting', async () => {
    const { recording } = await meetingRecordingFactory({ status: 'source_ready' });
    const assetId = vendorId('asset');

    const updated = await meetingRecordingsRepository.markIngesting(
      { id: recording.id, muxAssetId: assetId },
      db
    );

    expect(updated?.status).toBe('ingesting');
    expect(updated?.muxAssetId).toBe(assetId);
  });

  it('THE ORPHAN GUARD: an already-stamped asset id refuses a second, DIFFERENT asset', async () => {
    const { recording } = await meetingRecordingFactory({ status: 'source_ready' });
    const first = vendorId('asset');
    await meetingRecordingsRepository.markIngesting({ id: recording.id, muxAssetId: first }, db);

    // If this ever matched after a successful `assets.create`, a Mux asset would exist that
    // this row never points at. The caller MUST log the orphaned id at `error` — silently
    // dropping it leaks billable Mux storage with no trace.
    const orphan = await meetingRecordingsRepository.markIngesting(
      { id: recording.id, muxAssetId: vendorId('asset-two') },
      db
    );
    expect(orphan).toBeUndefined();

    const row = await meetingRecordingsRepository.findById(recording.id);
    expect(row?.muxAssetId).toBe(first);
  });

  it('refuses a row that is not source_ready', async () => {
    const { recording } = await meetingRecordingFactory({ status: 'recording' });

    const refused = await meetingRecordingsRepository.markIngesting(
      { id: recording.id, muxAssetId: vendorId('asset') },
      db
    );
    expect(refused).toBeUndefined();
  });
});

// ── 7. markReady (T8) ────────────────────────────────────────────────────────

describe('meetingRecordingsRepository.markReady', () => {
  it('reaches TERMINAL SUCCESS: playback id, ready_at, and Mux’s duration OVERWRITING Daily’s', async () => {
    const assetId = vendorId('asset');
    const { recording } = await meetingRecordingFactory({
      status: 'ingesting',
      muxAssetId: assetId, // T6 always stamps this before a row reaches `ingesting`.
      durationSeconds: 900, // Daily's number, recorded at source_ready
    });
    const at = new Date('2026-08-25T12:00:00.000Z');

    const updated = await meetingRecordingsRepository.markReady(
      {
        id: recording.id,
        muxAssetId: assetId,
        muxPlaybackId: vendorId('pb'),
        durationSeconds: 912,
        at,
      },
      db
    );

    expect(updated?.status).toBe('ready');
    expect(updated?.readyAt?.toISOString()).toBe(at.toISOString());
    // ⚠ On a `ready` row this column describes the PLAYABLE artefact — what BAL-440 renders
    // beside the player — not the pre-transcode source. Mux's number wins.
    expect(updated?.durationSeconds).toBe(912);
  });

  it('keeps Daily’s duration when Mux sends none (COALESCE the other way)', async () => {
    const assetId = vendorId('asset');
    const { recording } = await meetingRecordingFactory({
      status: 'ingesting',
      muxAssetId: assetId,
      durationSeconds: 900,
    });

    const updated = await meetingRecordingsRepository.markReady(
      {
        id: recording.id,
        muxAssetId: assetId,
        muxPlaybackId: vendorId('pb'),
        durationSeconds: null,
        at: new Date(),
      },
      db
    );
    expect(updated?.durationSeconds).toBe(900);
  });

  it('THE REPLAY: a second video.asset.ready returns undefined and preserves the first playback id', async () => {
    const assetId = vendorId('asset');
    const { recording } = await meetingRecordingFactory({
      status: 'ingesting',
      muxAssetId: assetId,
    });
    const playbackId = vendorId('pb');
    await meetingRecordingsRepository.markReady(
      { id: recording.id, muxAssetId: assetId, muxPlaybackId: playbackId, at: new Date() },
      db
    );

    const replay = await meetingRecordingsRepository.markReady(
      {
        id: recording.id,
        muxAssetId: assetId,
        muxPlaybackId: vendorId('pb-other'),
        at: new Date(),
      },
      db
    );
    expect(replay).toBeUndefined();

    const row = await meetingRecordingsRepository.findById(recording.id);
    expect(row?.muxPlaybackId).toBe(playbackId);
  });

  it('refuses a row that is not ingesting', async () => {
    const assetId = vendorId('asset');
    const { recording } = await meetingRecordingFactory({
      status: 'source_ready',
      muxAssetId: assetId,
    });

    const refused = await meetingRecordingsRepository.markReady(
      { id: recording.id, muxAssetId: assetId, muxPlaybackId: vendorId('pb'), at: new Date() },
      db
    );
    expect(refused).toBeUndefined();
  });

  /**
   * ⚠⚠ FIX ROUND 2 (R3) — THE TWO-ASSET ORPHAN HAZARD, closed by the `mux_asset_id` CAS term.
   * A row `ingesting` under asset #2 (the retry that won) must refuse a `video.asset.ready`
   * naming asset #1 (the orphaned first attempt) even though the STATUS matches — the status
   * alone is not enough to prove the event is about the asset this row actually points at.
   */
  it('⚠⚠ THE ORPHAN GUARD: refuses a video.asset.ready naming a DIFFERENT asset than the row', async () => {
    const rowAssetId = vendorId('asset-two'); // the retry that won `markIngesting`
    const orphanAssetId = vendorId('asset-one'); // the orphaned first attempt
    const { recording } = await meetingRecordingFactory({
      status: 'ingesting',
      muxAssetId: rowAssetId,
    });

    const refused = await meetingRecordingsRepository.markReady(
      {
        id: recording.id,
        muxAssetId: orphanAssetId,
        muxPlaybackId: vendorId('pb'),
        at: new Date(),
      },
      db
    );
    expect(refused).toBeUndefined();

    // The row still names ITS OWN asset — the orphan's playback id never landed here.
    const row = await meetingRecordingsRepository.findById(recording.id);
    expect(row?.status).toBe('ingesting');
    expect(row?.muxAssetId).toBe(rowAssetId);
    expect(row?.muxPlaybackId).toBeNull();
  });
});

// ── 8. markFailed (T4 / T5 / T7 / T9) ────────────────────────────────────────

describe('meetingRecordingsRepository.markFailed', () => {
  it('stamps stage + reason and RELEASES the capture slot from a recording row (T4/T5)', async () => {
    const { recording } = await meetingRecordingFactory();
    const at = new Date('2026-08-25T11:30:00.000Z');

    const updated = await meetingRecordingsRepository.markFailed(
      { id: recording.id, stage: 'daily', reason: 'recording could not be started', at },
      db
    );

    expect(updated?.status).toBe('failed');
    expect(updated?.failedStage).toBe('daily');
    expect(updated?.failureReason).toBe('recording could not be started');
    // ⚠ LOAD-BEARING: without this the row holds the meeting's capture slot forever and every
    // subsequent ensure — including this job's own BullMQ retry — silently no-ops (§5.1b).
    expect(updated?.captureEndedAt?.toISOString()).toBe(at.toISOString());
  });

  it('COALESCE: an already-settled row keeps its ORIGINAL capture_ended_at (T7/T9)', async () => {
    const { recording } = await meetingRecordingFactory();
    const released = new Date('2026-08-25T11:00:00.000Z');
    await meetingRecordingsRepository.markSourceReady({ id: recording.id, at: released }, db);

    const updated = await meetingRecordingsRepository.markFailed(
      {
        id: recording.id,
        stage: 'mux_ingest',
        reason: 'asset create exhausted its retries',
        at: new Date('2026-08-25T14:00:00.000Z'),
      },
      db
    );

    expect(updated?.status).toBe('failed');
    expect(updated?.failedStage).toBe('mux_ingest');
    // The slot was released when capture actually ended, not when the ingest gave up.
    expect(updated?.captureEndedAt?.toISOString()).toBe(released.toISOString());
  });

  it('caps failure_reason at FAILURE_REASON_MAX_LENGTH — a vendor HTML page must not bloat the row', async () => {
    const { recording } = await meetingRecordingFactory();
    const hugeBody = 'x'.repeat(FAILURE_REASON_MAX_LENGTH * 3);

    const updated = await meetingRecordingsRepository.markFailed(
      { id: recording.id, stage: 'daily', reason: hugeBody, at: new Date() },
      db
    );

    // Truncated at the single WRITE point, so no caller can forget to do it.
    expect(updated?.failureReason).toHaveLength(FAILURE_REASON_MAX_LENGTH);
  });

  it('is reachable from source_ready and from ingesting', async () => {
    const fromSourceReady = await meetingRecordingFactory({ status: 'source_ready' });
    const ingesting = await meetingRecordingFactory({ status: 'ingesting' });

    expect(
      (
        await meetingRecordingsRepository.markFailed(
          { id: fromSourceReady.recording.id, stage: 'mux_ingest', reason: 'r', at: new Date() },
          db
        )
      )?.status
    ).toBe('failed');
    expect(
      (
        await meetingRecordingsRepository.markFailed(
          { id: ingesting.recording.id, stage: 'mux_asset', reason: 'r', at: new Date() },
          db
        )
      )?.status
    ).toBe('failed');
  });

  it('⚠⚠ NEVER OVERWRITES A READY ROW — a late vendor error must not un-publish a segment', async () => {
    const { recording } = await meetingRecordingFactory({ status: 'ready' });
    const playbackId = vendorId('pb');
    await db
      .update(meetingRecordings)
      .set({ muxPlaybackId: playbackId })
      .where(eq(meetingRecordings.id, recording.id));

    // A late `recording.error` / `video.asset.errored` on a segment BAL-440 is already
    // rendering. `status <> 'ready'` refuses it silently, which is the correct answer.
    const refused = await meetingRecordingsRepository.markFailed(
      { id: recording.id, stage: 'mux_asset', reason: 'a late vendor error', at: new Date() },
      db
    );
    expect(refused).toBeUndefined();

    const row = await meetingRecordingsRepository.findById(recording.id);
    expect(row?.status).toBe('ready');
    expect(row?.muxPlaybackId).toBe(playbackId);
    expect(row?.failedStage).toBeNull();
    expect(row?.failureReason).toBeNull();
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F10) — FIRST FAILURE WINS. `failed → failed` used to be a silent CAS
   * success that OVERWROTE the first failure's `failed_stage`/`failure_reason` — losing the
   * root cause a runbook or a dispute would need. A SECOND, unrelated vendor error on an
   * already-`failed` row must now be refused exactly like the `ready` case above.
   */
  it('⚠⚠ refuses a SECOND failure — the FIRST failure_reason is never overwritten', async () => {
    const { recording } = await meetingRecordingFactory();
    const firstAt = new Date('2026-08-25T11:00:00.000Z');

    const first = await meetingRecordingsRepository.markFailed(
      { id: recording.id, stage: 'daily', reason: 'the ORIGINAL root cause', at: firstAt },
      db
    );
    expect(first?.status).toBe('failed');

    const second = await meetingRecordingsRepository.markFailed(
      {
        id: recording.id,
        stage: 'mux_ingest',
        reason: 'an unrelated LATER error',
        at: new Date('2026-08-25T12:00:00.000Z'),
      },
      db
    );
    expect(second).toBeUndefined();

    const row = await meetingRecordingsRepository.findById(recording.id);
    expect(row?.status).toBe('failed');
    expect(row?.failedStage).toBe('daily');
    expect(row?.failureReason).toBe('the ORIGINAL root cause');
    expect(row?.captureEndedAt?.toISOString()).toBe(firstAt.toISOString());
  });

  /**
   * ⚠⚠ BAL-480 FIX ROUND 1 — `onlyIfUnacknowledged` ADDS `daily_recording_id IS NULL` TO THE
   * CAS, for the stuck-slot reaper alone. `markStarted` does NOT move `status`, so the base
   * predicate cannot see a `recording.started` that lands between the reaper's staleness read
   * and its write; without this term the reap would overwrite a LIVE acknowledgement, release
   * its capture slot, and let a SECOND Daily recording start in the same room.
   */
  it('⚠⚠ onlyIfUnacknowledged REFUSES a row that already carries a Daily id (the reaper TOCTOU)', async () => {
    const { recording } = await meetingRecordingFactory();
    const acknowledged = await meetingRecordingsRepository.markStarted(
      { id: recording.id, dailyRecordingId: vendorId('daily'), startedAt: new Date() },
      db
    );
    expect(acknowledged?.dailyRecordingId).toBeDefined();

    const refused = await meetingRecordingsRepository.markFailed(
      {
        id: recording.id,
        stage: 'daily',
        reason: 'stuck: no Daily acknowledgement',
        at: new Date(),
        onlyIfUnacknowledged: true,
      },
      db
    );
    expect(refused).toBeUndefined();

    // The live segment is untouched — still `recording`, still holding its capture slot.
    const row = await meetingRecordingsRepository.findById(recording.id);
    expect(row?.status).toBe('recording');
    expect(row?.captureEndedAt).toBeNull();
    expect(row?.failureReason).toBeNull();
  });

  it('onlyIfUnacknowledged still ALLOWS the reap of a row Daily never acknowledged', async () => {
    const { recording } = await meetingRecordingFactory();

    const reaped = await meetingRecordingsRepository.markFailed(
      {
        id: recording.id,
        stage: 'daily',
        reason: 'stuck: no Daily acknowledgement',
        at: new Date(),
        onlyIfUnacknowledged: true,
      },
      db
    );

    expect(reaped?.status).toBe('failed');
    // The capture slot is RELEASED, which is what lets the reaper reinsert in one invocation.
    expect(reaped?.captureEndedAt).toBeInstanceOf(Date);
  });

  /**
   * ⚠ THE DEFAULT IS UNCHANGED, AND THAT IS THE POINT OF THE FLAG BEING OPT-IN. Every
   * pre-existing caller stamps a failure it OBSERVED and must still win against an acknowledged
   * row — a Daily `recording.error` on a segment that is mid-capture is exactly that case.
   */
  it('⚠ WITHOUT the flag, an acknowledged row is still failable — no caller changed semantics', async () => {
    const { recording } = await meetingRecordingFactory();
    await meetingRecordingsRepository.markStarted(
      { id: recording.id, dailyRecordingId: vendorId('daily'), startedAt: new Date() },
      db
    );

    const failed = await meetingRecordingsRepository.markFailed(
      { id: recording.id, stage: 'daily', reason: 'Daily reported an error', at: new Date() },
      db
    );

    expect(failed?.status).toBe('failed');
  });
});

// ── 9. markSourceDeleted (T10) ───────────────────────────────────────────────

describe('meetingRecordingsRepository.markSourceDeleted', () => {
  it('stamps source_deleted_at on a ready row and LEAVES THE STATUS ALONE', async () => {
    const { recording } = await meetingRecordingFactory({ status: 'ready' });
    const at = new Date('2026-08-25T13:00:00.000Z');

    const updated = await meetingRecordingsRepository.markSourceDeleted(
      { id: recording.id, at },
      db
    );

    expect(updated?.sourceDeletedAt?.toISOString()).toBe(at.toISOString());
    // T10 is a `ready` → `ready` edge. Only the Daily copy went; the Mux asset stays (D4).
    expect(updated?.status).toBe('ready');
  });

  it('THE REPLAY: a second cleanup returns undefined and preserves the ORIGINAL deletion instant', async () => {
    const { recording } = await meetingRecordingFactory({ status: 'ready' });
    const at = new Date('2026-08-25T13:00:00.000Z');
    await meetingRecordingsRepository.markSourceDeleted({ id: recording.id, at }, db);

    const replay = await meetingRecordingsRepository.markSourceDeleted(
      { id: recording.id, at: new Date('2026-08-25T15:00:00.000Z') },
      db
    );
    expect(replay).toBeUndefined();

    const row = await meetingRecordingsRepository.findById(recording.id);
    expect(row?.sourceDeletedAt?.toISOString()).toBe(at.toISOString());
  });

  it('⚠⚠ REFUSES A NON-READY ROW — the `status = ready` term IS decision D4 in SQL', async () => {
    const { recording } = await meetingRecordingFactory({ status: 'ingesting' });

    // The Daily source is the ONLY thing a failed Mux ingest can retry from. Deleting it
    // before the asset is confirmed playable turns a recoverable failure into a permanent one.
    const refused = await meetingRecordingsRepository.markSourceDeleted(
      { id: recording.id, at: new Date() },
      db
    );
    expect(refused).toBeUndefined();
  });

  it('refuses a FAILED row too — a failed segment’s source is exactly what a retry needs', async () => {
    const { recording } = await meetingRecordingFactory({ status: 'failed' });

    const refused = await meetingRecordingsRepository.markSourceDeleted(
      { id: recording.id, at: new Date() },
      db
    );
    expect(refused).toBeUndefined();
  });
});

// ── 10. softDelete ───────────────────────────────────────────────────────────

describe('meetingRecordingsRepository.softDelete', () => {
  it('stamps deleted_at and returns the row; a second call returns undefined', async () => {
    const { recording } = await meetingRecordingFactory();

    const deleted = await meetingRecordingsRepository.softDelete({ id: recording.id });
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    // Already-deleted and never-existed are the SAME answer, so probing teaches nothing.
    expect(await meetingRecordingsRepository.softDelete({ id: recording.id })).toBeUndefined();
    expect(await meetingRecordingsRepository.softDelete({ id: randomUUID() })).toBeUndefined();
  });

  it('leaves every sibling segment untouched', async () => {
    const { meeting } = await meetingFactory();
    const first = await meetingRecordingFactory({ meetingId: meeting.id, status: 'ready' });
    const second = await meetingRecordingFactory({ meetingId: meeting.id, status: 'recording' });

    await meetingRecordingsRepository.softDelete({ id: first.recording.id });

    const live = await db
      .select()
      .from(meetingRecordings)
      .where(and(eq(meetingRecordings.meetingId, meeting.id), isNull(meetingRecordings.deletedAt)));
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(second.recording.id);
  });
});
