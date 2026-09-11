import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  CAPTURE_HEALTH_RANK,
  captureHealthRankOf,
  deriveCaptureHealthCategory,
  deriveRecapLadder,
  deriveRecordingLadder,
  deriveTranscriptionLadder,
} from '@balo/shared/capture-health';
import { db } from '../client';
import {
  consultations,
  expertProfiles,
  meetingContexts,
  meetingRecordings,
  meetings,
  transcripts,
} from '../schema';
import {
  agencyFactory,
  caseEngagementFactory,
  companyFactory,
  expertDraftFactory,
  meetingFactory,
  meetingRecordingFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
  transcriptFactory,
  userFactory,
} from '../test/factories';
import { captureHealthRepository, type CaptureHealthWindow } from './capture-health';

/**
 * BAL-550 — `captureHealthRepository`, the meeting-grain windowed read behind
 * `/admin/health/capture`.
 *
 * ⚠⚠ THE CENTREPIECE IS THE RANK MATRIX. Two definitions of "which ladder is this meeting's
 * problem" exist by necessity — the SQL `CASE` that ORDERS and COUNTS in Postgres, and
 * `deriveCaptureHealthCategory` in `@balo/shared/capture-health` that RENDERS in the browser.
 * Nothing but this file keeps them in agreement: it seeds every ladder combination and asserts
 * `captureHealthRankOf(row.facts) === row.healthRank` for EVERY row. If that assertion is ever
 * weakened, the two definitions are free to drift and the page will sort by one rule while
 * labelling by another.
 *
 * ⚠ EVERY TEST STARTS ON AN EMPTY DATABASE — the harness holds each test in one transaction
 * that rolls back, so `hasAnyRecording` and the unfiltered counts are meaningful without
 * cleanup.
 *
 * ⚠ NOTHING HERE WRITES THROUGH THE REPOSITORY. Every method under test READS; the fixtures
 * are seeded by factories and raw inserts, which is also the only way to reach states the
 * state machine would refuse to produce in order.
 */

const WINDOW: CaptureHealthWindow = {
  from: new Date('2026-05-01T00:00:00.000Z'),
  to: new Date('2026-06-01T00:00:00.000Z'),
};
/** The single pinned "now − 24h" instant the page computes ONCE per request. */
const WITHHELD_BEFORE = new Date('2026-05-20T00:00:00.000Z');
/** Submitted BEFORE the threshold ⇒ withheld. */
const LONG_AGO = new Date('2026-05-02T00:00:00.000Z');
/** Submitted AFTER the threshold ⇒ merely open. */
const RECENTLY = new Date('2026-05-25T00:00:00.000Z');

const HOUR_MS = 3_600_000;

/** A fresh, collision-proof vendor-shaped id (both vendor id columns are partial-unique). */
function vendorId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function at(day: number): Date {
  return new Date(Date.UTC(2026, 4, day, 12, 0, 0));
}

/** One meeting inside the window, with the default single `case` context. */
async function seedMeeting(start: Date) {
  const result = await meetingFactory({
    values: { scheduledStart: start, scheduledEnd: new Date(start.getTime() + HOUR_MS) },
  });
  const engagementId = result.caseEngagementId;
  if (engagementId === undefined) throw new Error('expected the default case context');
  return { meetingId: result.meeting.id, engagementId };
}

/** A READY segment whose batch transcription finished — the healthy recording+transcription. */
async function seedReadySegment(meetingId: string) {
  return meetingRecordingFactory({
    meetingId,
    status: 'ready',
    dailyRecordingId: vendorId('daily'),
    muxAssetId: vendorId('mux'),
    muxPlaybackId: vendorId('play'),
    transcriptJobId: vendorId('job'),
    transcriptJobSubmittedAt: LONG_AGO,
    transcriptJobFinishedAt: RECENTLY,
  });
}

/**
 * A kickoff that legitimately carries BOTH the request-grain `project_discovery` row and the
 * engagement-grain `project_kickoff` row — the fixture the precedence pick exists for.
 */
async function seedDualContextMeeting() {
  const client = await companyFactory({ name: 'Northwind Industrial' });
  const request = await projectRequestFactory({ companyId: client.id });
  const engagement = await caseEngagementFactory({ companyId: client.id });
  const meeting = await meetingFactory({
    contexts: [
      { contextType: 'project_discovery', contextId: request.id },
      { contextType: 'project_kickoff', contextId: engagement.engagement.id },
    ],
    values: { scheduledStart: at(9), scheduledEnd: new Date(at(9).getTime() + HOUR_MS) },
  });
  return { meetingId: meeting.meeting.id, engagementId: engagement.engagement.id };
}

/** Reads the whole window in one page — the fixtures are small by construction. */
async function listAll(
  category: Parameters<typeof captureHealthRepository.listPage>[0]['category'] = null
) {
  return captureHealthRepository.listPage({
    window: WINDOW,
    category,
    withheldBefore: WITHHELD_BEFORE,
    limit: 100,
  });
}

// ── 1. The grain (D8) ────────────────────────────────────────────────────────

describe('captureHealthRepository.listPage — grain', () => {
  it('⚠⚠ ONE ROW PER MEETING, not one per segment, however many segments it has', async () => {
    const { meetingId } = await seedMeeting(at(10));
    // Three live segments — a real rejoin story. `meeting_recordings` is per SEGMENT and the
    // meeting has no unique constraint over them, so a naive join would emit three rows.
    await seedReadySegment(meetingId);
    await seedReadySegment(meetingId);
    await meetingRecordingFactory({
      meetingId,
      status: 'failed',
      dailyRecordingId: vendorId('daily'),
      failedStage: 'mux_ingest',
      failureReason: '422 invalid_parameters',
    });

    const { rows } = await listAll();

    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error('expected exactly one row');
    expect(row.meetingId).toBe(meetingId);
    expect(row.facts.recording.segmentCount).toBe(3);
    // WORST STATE DOMINATES: one failed segment beats two ready ones.
    expect(deriveRecordingLadder(row.facts)).toBe('failed');
  });

  it('a meeting with NO recording is not a capture-health row at all (the INNER join)', async () => {
    await seedMeeting(at(10));

    const { rows } = await listAll();

    expect(rows).toEqual([]);
  });
});

// ── 2. THE SQL ↔ TS RANK MATRIX ──────────────────────────────────────────────

describe('captureHealthRepository — the SQL rank agrees with the TS derivation', () => {
  /** Seeds one meeting per ladder combination and returns the label → meetingId map. */
  async function seedEveryCombination(): Promise<Map<string, string>> {
    const byLabel = new Map<string, string>();

    // 1. HEALTHY — ready segment, finished job, published recap.
    const healthy = await seedMeeting(at(2));
    await seedReadySegment(healthy.meetingId);
    await transcriptFactory({
      meetingId: healthy.meetingId,
      engagementId: healthy.engagementId,
      values: { status: 'ready' },
    });
    byLabel.set('healthy', healthy.meetingId);

    // 2. RECORDING FAILED, and re-drivable (source present, Daily id present).
    const failedRedrivable = await seedMeeting(at(3));
    await meetingRecordingFactory({
      meetingId: failedRedrivable.meetingId,
      status: 'failed',
      dailyRecordingId: vendorId('daily'),
      muxAssetId: vendorId('mux'),
      failedStage: 'mux_ingest',
      failureReason: '422 invalid_parameters',
    });
    byLabel.set('recording-failed-redrivable', failedRedrivable.meetingId);

    // 3. RECORDING FAILED, NOT re-drivable — the Daily source is gone.
    const failedPermanent = await seedMeeting(at(4));
    await meetingRecordingFactory({
      meetingId: failedPermanent.meetingId,
      status: 'failed',
      dailyRecordingId: vendorId('daily'),
      sourceDeletedAt: new Date('2026-05-05T00:00:00.000Z'),
      failedStage: 'mux_asset',
      failureReason: 'asset errored',
    });
    byLabel.set('recording-failed-permanent', failedPermanent.meetingId);

    // 4. STUCK AT source_ready — nobody is driving the ingest.
    const sourceReady = await seedMeeting(at(5));
    await meetingRecordingFactory({
      meetingId: sourceReady.meetingId,
      status: 'source_ready',
      dailyRecordingId: vendorId('daily'),
    });
    byLabel.set('recording-source-ready', sourceReady.meetingId);

    // 5. STILL CAPTURING.
    const capturing = await seedMeeting(at(6));
    await meetingRecordingFactory({ meetingId: capturing.meetingId, status: 'recording' });
    byLabel.set('recording-capturing', capturing.meetingId);

    // 6. INGESTING — a Mux callback genuinely in flight.
    const ingesting = await seedMeeting(at(7));
    await meetingRecordingFactory({
      meetingId: ingesting.meetingId,
      status: 'ingesting',
      dailyRecordingId: vendorId('daily'),
      muxAssetId: vendorId('mux'),
    });
    byLabel.set('recording-ingesting', ingesting.meetingId);

    // 7. TRANSCRIPTION FAILED — the batch processor errored.
    const txFailed = await seedMeeting(at(8));
    await meetingRecordingFactory({
      meetingId: txFailed.meetingId,
      status: 'ready',
      dailyRecordingId: vendorId('daily'),
      transcriptJobId: vendorId('job'),
      transcriptJobSubmittedAt: LONG_AGO,
      transcriptJobFinishedAt: RECENTLY,
      transcriptJobFailureReason: 'batch processor gave up',
    });
    byLabel.set('transcription-failed', txFailed.meetingId);

    // 8. TRANSCRIPTION WITHHELD — submitted before the threshold, never answered.
    const withheld = await seedMeeting(at(9));
    await meetingRecordingFactory({
      meetingId: withheld.meetingId,
      status: 'ready',
      dailyRecordingId: vendorId('daily'),
      transcriptJobId: vendorId('job'),
      transcriptJobSubmittedAt: LONG_AGO,
    });
    byLabel.set('transcription-withheld', withheld.meetingId);

    // 9. TRANSCRIPTION OPEN but not yet withheld — submitted AFTER the threshold.
    const submitted = await seedMeeting(at(10));
    await meetingRecordingFactory({
      meetingId: submitted.meetingId,
      status: 'ready',
      dailyRecordingId: vendorId('daily'),
      transcriptJobId: vendorId('job'),
      transcriptJobSubmittedAt: RECENTLY,
    });
    byLabel.set('transcription-submitted', submitted.meetingId);

    // 10. TRANSCRIPTION `na` — ready source, nothing ever submitted.
    const neverSubmitted = await seedMeeting(at(11));
    await meetingRecordingFactory({
      meetingId: neverSubmitted.meetingId,
      status: 'ready',
      dailyRecordingId: vendorId('daily'),
    });
    byLabel.set('transcription-na', neverSubmitted.meetingId);

    // 11. NO ENGAGEMENT CONTEXT — an `admin` meeting. Nothing was ever going to transcribe it.
    const adminMeeting = await meetingFactory({
      contexts: [{ contextType: 'admin', contextId: null }],
      values: { scheduledStart: at(12), scheduledEnd: new Date(at(12).getTime() + HOUR_MS) },
    });
    await meetingRecordingFactory({
      meetingId: adminMeeting.meeting.id,
      status: 'ready',
      dailyRecordingId: vendorId('daily'),
    });
    byLabel.set('no-engagement-context', adminMeeting.meeting.id);

    // 12. RECAP FAILED.
    const recapFailed = await seedMeeting(at(13));
    await seedReadySegment(recapFailed.meetingId);
    await transcriptFactory({
      meetingId: recapFailed.meetingId,
      engagementId: recapFailed.engagementId,
      values: { status: 'failed', failedStage: 'summarize', failureReason: 'llm timed out' },
    });
    byLabel.set('recap-failed', recapFailed.meetingId);

    // 13. ⚠⚠ RECAP PARTIAL — `ready` WITH a recorded stage skip. NEVER a failure.
    const recapPartial = await seedMeeting(at(14));
    await seedReadySegment(recapPartial.meetingId);
    await transcriptFactory({
      meetingId: recapPartial.meetingId,
      engagementId: recapPartial.engagementId,
      values: { status: 'ready', failedStage: 'action_items', failureReason: 'engagement ended' },
    });
    byLabel.set('recap-partial', recapPartial.meetingId);

    // 14. RECAP PROCESSING.
    const recapProcessing = await seedMeeting(at(15));
    await seedReadySegment(recapProcessing.meetingId);
    await transcriptFactory({
      meetingId: recapProcessing.meetingId,
      engagementId: recapProcessing.engagementId,
      values: { status: 'processing' },
    });
    byLabel.set('recap-processing', recapProcessing.meetingId);

    // 15. NO TRANSCRIPT ROW AT ALL, though the job finished.
    const recapNone = await seedMeeting(at(16));
    await seedReadySegment(recapNone.meetingId);
    byLabel.set('recap-none', recapNone.meetingId);

    // 16. MULTI-SEGMENT: a failed segment beside two ready ones.
    const multi = await seedMeeting(at(17));
    await seedReadySegment(multi.meetingId);
    await seedReadySegment(multi.meetingId);
    await meetingRecordingFactory({
      meetingId: multi.meetingId,
      status: 'failed',
      dailyRecordingId: vendorId('daily'),
      failedStage: 'daily',
      failureReason: 'recording.error',
    });
    byLabel.set('multi-segment', multi.meetingId);

    return byLabel;
  }

  it('⚠⚠ THE MATRIX: every seeded ladder combination ranks identically in SQL and in TS', async () => {
    const byLabel = await seedEveryCombination();
    const { rows } = await listAll();

    // Non-vacuity: every seeded meeting must actually be in the result set, or the per-row
    // assertion below would pass over an empty list.
    expect(rows).toHaveLength(byLabel.size);

    for (const row of rows) {
      expect({
        meetingId: row.meetingId,
        sqlRank: row.healthRank,
      }).toEqual({
        meetingId: row.meetingId,
        sqlRank: captureHealthRankOf(row.facts),
      });
    }
  });

  it('the named combinations land in the ladders and categories the design specifies', async () => {
    const byLabel = await seedEveryCombination();
    const { rows } = await listAll();
    const byMeetingId = new Map(rows.map((row) => [row.meetingId, row]));
    const factsFor = (label: string) => {
      const meetingId = byLabel.get(label);
      if (meetingId === undefined) throw new Error(`no fixture for ${label}`);
      const row = byMeetingId.get(meetingId);
      if (row === undefined) throw new Error(`fixture ${label} is missing from the page`);
      return row;
    };

    expect(deriveCaptureHealthCategory(factsFor('healthy').facts)).toBe('healthy');
    expect(deriveCaptureHealthCategory(factsFor('recording-failed-redrivable').facts)).toBe(
      'recording'
    );
    expect(factsFor('recording-failed-redrivable').facts.recording.anyRedrivableFailure).toBe(true);
    // ⚠ The source is gone, so the CAS would refuse — the page must NOT offer a button.
    expect(factsFor('recording-failed-permanent').facts.recording.anyRedrivableFailure).toBe(false);
    expect(deriveRecordingLadder(factsFor('recording-source-ready').facts)).toBe('source_ready');
    expect(deriveRecordingLadder(factsFor('recording-capturing').facts)).toBe('capturing');
    expect(deriveRecordingLadder(factsFor('recording-ingesting').facts)).toBe('ingesting');
    expect(deriveTranscriptionLadder(factsFor('transcription-failed').facts)).toBe('failed');
    expect(deriveTranscriptionLadder(factsFor('transcription-withheld').facts)).toBe('withheld');
    expect(deriveTranscriptionLadder(factsFor('transcription-submitted').facts)).toBe('submitted');
    expect(deriveTranscriptionLadder(factsFor('transcription-na').facts)).toBe('na');
    expect(factsFor('no-engagement-context').facts.hasEngagementContext).toBe(false);
    expect(deriveTranscriptionLadder(factsFor('no-engagement-context').facts)).toBe('na');
    expect(deriveRecapLadder(factsFor('recap-failed').facts)).toBe('failed');
    // ⚠⚠ THE CONFLATION THE TICKET FORBIDS: a partial recap is `partial`, never `failed`.
    expect(deriveRecapLadder(factsFor('recap-partial').facts)).toBe('partial');
    expect(factsFor('recap-partial').facts.recap.anyFailed).toBe(false);
    expect(deriveRecapLadder(factsFor('recap-processing').facts)).toBe('processing');
    expect(deriveRecapLadder(factsFor('recap-none').facts)).toBe('none');
    expect(factsFor('multi-segment').facts.recording.segmentCount).toBe(3);
  });

  it('ISSUES FIRST: the page is ordered by health_rank ASC, then newest first', async () => {
    await seedEveryCombination();
    const { rows } = await listAll();

    const ranks = rows.map((row) => row.healthRank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    // Inside one rank, newest first.
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1];
      const current = rows[i];
      if (previous === undefined || current === undefined) throw new Error('unreachable');
      if (previous.healthRank !== current.healthRank) continue;
      expect(previous.scheduledStart.getTime()).toBeGreaterThanOrEqual(
        current.scheduledStart.getTime()
      );
    }
  });

  it('the category filter selects exactly the rows whose derived category matches', async () => {
    await seedEveryCombination();

    const { rows } = await listAll('recording');

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.healthRank).toBe(CAPTURE_HEALTH_RANK.recording);
      expect(deriveCaptureHealthCategory(row.facts)).toBe('recording');
    }
  });
});

// ── 3. The keyset ────────────────────────────────────────────────────────────

/** A meeting whose only segment FAILED its Mux ingest — health rank 0. */
async function seedFailedIngestMeeting(start: Date): Promise<void> {
  const { meetingId } = await seedMeeting(start);
  await meetingRecordingFactory({
    meetingId,
    status: 'failed',
    dailyRecordingId: vendorId('daily'),
    failedStage: 'mux_ingest',
    failureReason: 'boom',
  });
}

/** A meeting that recorded, transcribed and recapped cleanly — health rank 3. */
async function seedHealthyMeeting(start: Date): Promise<void> {
  const { meetingId, engagementId } = await seedMeeting(start);
  await seedReadySegment(meetingId);
  await transcriptFactory({ meetingId, engagementId, values: { status: 'ready' } });
}

/**
 * Pages the whole window `limit` rows at a time, feeding each page's last row back as the
 * cursor, and returns the meeting ids in the order the walk saw them. The `guard` is a
 * non-termination tripwire, not a page budget.
 */
async function walkKeyset(limit: number, maxPages: number): Promise<string[]> {
  const seen: string[] = [];
  let after: Parameters<typeof captureHealthRepository.listPage>[0]['after'];
  let hasMore = true;
  let guard = 0;
  while (hasMore) {
    if (guard++ > maxPages) throw new Error('the keyset failed to terminate');
    const page = await captureHealthRepository.listPage({
      window: WINDOW,
      category: null,
      withheldBefore: WITHHELD_BEFORE,
      after,
      limit,
    });
    for (const row of page.rows) seen.push(row.meetingId);
    hasMore = page.hasMore;
    const last = page.rows[page.rows.length - 1];
    after =
      last === undefined
        ? undefined
        : {
            healthRank: last.healthRank,
            scheduledStart: last.scheduledStart,
            meetingId: last.meetingId,
          };
  }
  return seen;
}

describe('captureHealthRepository.listPage — the keyset', () => {
  it('⚠ TOTAL AND EXACTLY-ONCE: five rows over three pages of two, in the same order', async () => {
    // Two failed (rank 0) and three healthy (rank 3), so the pages straddle a rank boundary.
    for (const day of [3, 4]) await seedFailedIngestMeeting(at(day));
    for (const day of [5, 6, 7]) await seedHealthyMeeting(at(day));

    const expected = (await listAll()).rows.map((row) => row.meetingId);
    expect(expected).toHaveLength(5);

    const seen = await walkKeyset(2, 5);

    // Exactly once, in exactly the single-page order — no skips, no repeats.
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /**
   * ⚠⚠ THE KEYSET'S THIRD ARM — `rank = $ AND scheduled_start = $ AND id < $` — AND THE ONLY
   * FIXTURE THAT REACHES IT. The walk above gives every meeting a distinct `at(day)`, so the
   * second arm (`scheduled_start < $`) settles every step and the third is dead weight:
   * reversing its comparison, or deleting it outright, leaves that test green.
   *
   * `meetings.scheduled_start` is NOT unique and collisions are ordinary — the same slot booked
   * in two different tenants. When such a pair STRADDLES a page boundary, a keyset without a
   * working tie-break skips one of them permanently (the second arm excludes an equal
   * timestamp) and the page silently loses a row.
   *
   * The fixture puts the tie at positions 3 and 4 of a 5-row order paged 2 at a time, so the
   * cursor handed to the third page IS one half of the tie and the other half is reachable
   * ONLY through the third arm.
   *
   * ⚠ NON-VACUITY PROOF: flip `lt(meetings.id, after.meetingId)` to `gt(...)` in
   * `listPage` (or drop the arm). This test MUST go red with a 4-row walk against a 5-row
   * expectation; the walk above stays green either way.
   */
  it('⚠ TIE-BREAK: two meetings sharing a scheduled_start, straddling a page boundary', async () => {
    // Two failed (rank 0) so the tie sits below a rank boundary rather than at the very top.
    for (const day of [3, 4]) await seedFailedIngestMeeting(at(day));
    // Three healthy (rank 3): one at day 7, then TWO at the SAME instant — the same slot held
    // by two different tenants, which the schema permits and the ordering must survive.
    const tiedAt = at(6);
    for (const start of [at(7), tiedAt, tiedAt]) await seedHealthyMeeting(start);

    const expectedRows = (await listAll()).rows;
    expect(expectedRows).toHaveLength(5);

    // The fixture's own guard: the tie must actually STRADDLE the boundary of the second page
    // (rows 3 and 4 of a 0-indexed walk paged 2 at a time). Without this the test could quietly
    // become vacuous again if the ordering or the fixture changed.
    const [, , , fourth, fifth] = expectedRows;
    if (fourth === undefined || fifth === undefined) throw new Error('expected five rows');
    expect(fourth.scheduledStart.getTime()).toBe(fifth.scheduledStart.getTime());
    expect(fourth.healthRank).toBe(fifth.healthRank);

    const seen = await walkKeyset(2, 5);

    // The second half of the tie is reachable ONLY through the third arm.
    expect(seen).toEqual(expectedRows.map((row) => row.meetingId));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('`hasMore` is false on the last page even when it is exactly full', async () => {
    for (const day of [5, 6]) {
      const { meetingId } = await seedMeeting(at(day));
      await seedReadySegment(meetingId);
    }

    const page = await captureHealthRepository.listPage({
      window: WINDOW,
      category: null,
      withheldBefore: WITHHELD_BEFORE,
      limit: 2,
    });

    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });
});

// ── 4. The window ────────────────────────────────────────────────────────────

describe('captureHealthRepository.listPage — the window is [from, to)', () => {
  it('`from` is IN and `to` is OUT', async () => {
    const onFrom = await meetingFactory({
      values: {
        scheduledStart: WINDOW.from,
        scheduledEnd: new Date(WINDOW.from.getTime() + HOUR_MS),
      },
    });
    await seedReadySegment(onFrom.meeting.id);
    const onTo = await meetingFactory({
      values: {
        scheduledStart: WINDOW.to,
        scheduledEnd: new Date(WINDOW.to.getTime() + HOUR_MS),
      },
    });
    await seedReadySegment(onTo.meeting.id);

    const ids = (await listAll()).rows.map((row) => row.meetingId);

    expect(ids).toContain(onFrom.meeting.id);
    expect(ids).not.toContain(onTo.meeting.id);
  });
});

// ── 5. countByCategory ───────────────────────────────────────────────────────

describe('captureHealthRepository.countByCategory', () => {
  it('the four tiles sum to the unfiltered row count, over the same population', async () => {
    const failed = await seedMeeting(at(3));
    await meetingRecordingFactory({
      meetingId: failed.meetingId,
      status: 'failed',
      dailyRecordingId: vendorId('daily'),
      failedStage: 'mux_ingest',
      failureReason: 'boom',
    });
    const withheld = await seedMeeting(at(4));
    await meetingRecordingFactory({
      meetingId: withheld.meetingId,
      status: 'ready',
      dailyRecordingId: vendorId('daily'),
      transcriptJobId: vendorId('job'),
      transcriptJobSubmittedAt: LONG_AGO,
    });
    const partial = await seedMeeting(at(5));
    await seedReadySegment(partial.meetingId);
    await transcriptFactory({
      meetingId: partial.meetingId,
      engagementId: partial.engagementId,
      values: { status: 'ready', failedStage: 'action_items', failureReason: 'skipped' },
    });
    const healthy = await seedMeeting(at(6));
    await seedReadySegment(healthy.meetingId);
    await transcriptFactory({
      meetingId: healthy.meetingId,
      engagementId: healthy.engagementId,
      values: { status: 'ready' },
    });

    const counts = await captureHealthRepository.countByCategory({
      window: WINDOW,
      withheldBefore: WITHHELD_BEFORE,
    });
    const { rows } = await listAll();

    expect(counts).toEqual({ recording: 1, transcription: 1, recap: 1, healthy: 1 });
    expect(counts.recording + counts.transcription + counts.recap + counts.healthy).toBe(
      rows.length
    );
  });

  it('answers all zeroes on an empty window rather than throwing', async () => {
    const counts = await captureHealthRepository.countByCategory({
      window: WINDOW,
      withheldBefore: WITHHELD_BEFORE,
    });

    expect(counts).toEqual({ recording: 0, transcription: 0, recap: 0, healthy: 0 });
  });
});

// ── 6. Soft deletes ──────────────────────────────────────────────────────────

describe('captureHealthRepository — soft-deleted rows are invisible', () => {
  it('a soft-deleted MEETING drops out of the page entirely', async () => {
    const { meetingId } = await seedMeeting(at(5));
    await seedReadySegment(meetingId);
    await db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, meetingId));

    expect((await listAll()).rows).toEqual([]);
  });

  it('a soft-deleted RECORDING takes the row with it (the population is recorded meetings)', async () => {
    const { meetingId } = await seedMeeting(at(5));
    const { recording } = await seedReadySegment(meetingId);
    await db
      .update(meetingRecordings)
      .set({ deletedAt: new Date() })
      .where(eq(meetingRecordings.id, recording.id));

    expect((await listAll()).rows).toEqual([]);
  });

  it('a soft-deleted TRANSCRIPT leaves the row with no recap facts', async () => {
    const { meetingId, engagementId } = await seedMeeting(at(5));
    await seedReadySegment(meetingId);
    const { transcript } = await transcriptFactory({
      meetingId,
      engagementId,
      values: { status: 'failed', failedStage: 'summarize', failureReason: 'boom' },
    });
    await db
      .update(transcripts)
      .set({ deletedAt: new Date() })
      .where(eq(transcripts.id, transcript.id));

    const { rows } = await listAll();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.facts.recap).toEqual({
      transcriptCount: 0,
      anyFailed: false,
      anyPartial: false,
      anyProcessing: false,
      anyReady: false,
    });
    // The failed recap is gone, so the meeting is no longer a recap issue.
    expect(rows[0]?.healthRank).toBe(CAPTURE_HEALTH_RANK.healthy);
  });

  it('a soft-deleted CONTEXT row makes the meeting read as having no engagement', async () => {
    const { meetingId } = await seedMeeting(at(5));
    await seedReadySegment(meetingId);
    await db
      .update(meetingContexts)
      .set({ deletedAt: new Date() })
      .where(eq(meetingContexts.meetingId, meetingId));

    const { rows } = await listAll();

    expect(rows[0]?.facts.hasEngagementContext).toBe(false);
  });
});

// ── 7. findByMeetingId + hasAnyRecording ─────────────────────────────────────

describe('captureHealthRepository.findByMeetingId', () => {
  it('⚠⚠ ANSWERS OUTSIDE THE WINDOW — the deep link must resolve whatever its age', async () => {
    // Two years before the window the page defaults to.
    const old = await meetingFactory({
      values: {
        scheduledStart: new Date('2024-01-15T12:00:00.000Z'),
        scheduledEnd: new Date('2024-01-15T13:00:00.000Z'),
      },
    });
    await meetingRecordingFactory({
      meetingId: old.meeting.id,
      status: 'failed',
      dailyRecordingId: vendorId('daily'),
      failedStage: 'mux_ingest',
      failureReason: 'boom',
    });

    // Not on the windowed page…
    expect((await listAll()).rows).toEqual([]);
    // …but the deep link still resolves it.
    const row = await captureHealthRepository.findByMeetingId({
      meetingId: old.meeting.id,
      withheldBefore: WITHHELD_BEFORE,
    });

    if (row === undefined) throw new Error('expected the deep link to resolve');
    expect(row.meetingId).toBe(old.meeting.id);
    expect(row.healthRank).toBe(CAPTURE_HEALTH_RANK.recording);
    expect(captureHealthRankOf(row.facts)).toBe(row.healthRank);
  });

  it('answers `undefined` for a meeting that was never recorded, and for an unknown id', async () => {
    const { meetingId } = await seedMeeting(at(5));

    expect(
      await captureHealthRepository.findByMeetingId({ meetingId, withheldBefore: WITHHELD_BEFORE })
    ).toBeUndefined();
    expect(
      await captureHealthRepository.findByMeetingId({
        meetingId: randomUUID(),
        withheldBefore: WITHHELD_BEFORE,
      })
    ).toBeUndefined();
  });
});

describe('captureHealthRepository.hasAnyRecording', () => {
  it('distinguishes TRUE zero from a windowed zero', async () => {
    expect(await captureHealthRepository.hasAnyRecording()).toBe(false);

    // A recording OUTSIDE the page's window still means "the platform has recorded something",
    // which is the whole point — the empty state must not claim nothing was ever recorded.
    const old = await meetingFactory({
      values: {
        scheduledStart: new Date('2024-01-15T12:00:00.000Z'),
        scheduledEnd: new Date('2024-01-15T13:00:00.000Z'),
      },
    });
    await seedReadySegment(old.meeting.id);

    expect(await captureHealthRepository.hasAnyRecording()).toBe(true);
    expect((await listAll()).rows).toEqual([]);
  });

  it('a soft-deleted segment does not count', async () => {
    const { meetingId } = await seedMeeting(at(5));
    const { recording } = await seedReadySegment(meetingId);
    await db
      .update(meetingRecordings)
      .set({ deletedAt: new Date() })
      .where(eq(meetingRecordings.id, recording.id));

    expect(await captureHealthRepository.hasAnyRecording()).toBe(false);
  });
});

// ── 8. loadDetails ───────────────────────────────────────────────────────────

describe('captureHealthRepository.loadDetails', () => {
  it('short-circuits on an empty id list', async () => {
    const details = await captureHealthRepository.loadDetails([]);

    expect(details.recordings.size).toBe(0);
    expect(details.recap.size).toBe(0);
    expect(details.expert.size).toBe(0);
    expect(details.party.size).toBe(0);
  });

  it('returns segments OLDEST FIRST and SANITISES vendor failure text', async () => {
    const { meetingId } = await seedMeeting(at(5));
    const first = await meetingRecordingFactory({
      meetingId,
      status: 'failed',
      dailyRecordingId: vendorId('daily'),
      failedStage: 'mux_ingest',
      // ⚠ A Mux `invalid_parameters` body echoes the offending input — which for
      // `assets.create` is the LIVE DAILY SIGNED ACCESS LINK. It must never reach the web app.
      failureReason: '422 {"url":"https://daily.example.com/rec?token=SECRET"}',
      createdAt: new Date('2026-05-05T09:00:00.000Z'),
    });
    const second = await meetingRecordingFactory({
      meetingId,
      status: 'ready',
      dailyRecordingId: vendorId('daily'),
      createdAt: new Date('2026-05-05T10:00:00.000Z'),
    });

    const details = await captureHealthRepository.loadDetails([meetingId]);
    const segments = details.recordings.get(meetingId);

    expect(segments?.map((segment) => segment.id)).toEqual([
      first.recording.id,
      second.recording.id,
    ]);
    // ⚠ The redaction is greedy to the next WHITESPACE, so it swallows the closing `"}` of a
    // JSON body too — byte-for-byte what `apps/api/src/lib/sanitize-error.ts` does. The point
    // is the secret, not the punctuation.
    expect(segments?.[0]?.failureReason).toBe('422 {"url":"[redacted-url]');
    expect(segments?.[0]?.failureReason).not.toContain('SECRET');
  });

  it('returns the NEWEST live transcript per meeting, and never its jsonb payloads', async () => {
    const { meetingId, engagementId } = await seedMeeting(at(5));
    await transcriptFactory({
      meetingId,
      engagementId,
      values: { status: 'failed', createdAt: new Date('2026-05-05T09:00:00.000Z') },
    });
    const { transcript: newest } = await transcriptFactory({
      meetingId,
      engagementId,
      values: { status: 'processing', createdAt: new Date('2026-05-05T11:00:00.000Z') },
    });

    const details = await captureHealthRepository.loadDetails([meetingId]);
    const recap = details.recap.get(meetingId);

    expect(recap?.id).toBe(newest.id);
    expect(recap?.status).toBe('processing');
    // ⚠ THE PROJECTION DOCTRINE: `canonical` and `extracted_action_items` are multi-hundred-KB
    // jsonb and must never be in this shape.
    expect(recap).not.toHaveProperty('canonical');
    expect(recap).not.toHaveProperty('extractedActionItems');
  });

  it('resolves the EXPERT through the shipped `consultations` projection, with their agency', async () => {
    const agency = await agencyFactory({ name: 'CloudPeak' });
    const user = await userFactory({ firstName: 'Dana', lastName: 'Whitfield' });
    const expert = await expertDraftFactory({ userId: user.id });
    const { meetingId } = await seedMeeting(at(5));
    // `consultations` is the write-time projection the booking path maintains; this read is
    // REUSE of it, so the fixture writes the same row the projection would.
    await db.insert(consultations).values({
      meetingId,
      expertProfileId: expert.id,
      startAt: at(5),
      endAt: new Date(at(5).getTime() + HOUR_MS),
    });

    const withoutAgency = await captureHealthRepository.loadDetails([meetingId]);
    expect(withoutAgency.expert.get(meetingId)).toEqual({
      meetingId,
      expertProfileId: expert.id,
      firstName: 'Dana',
      lastName: 'Whitfield',
      // ⚠ NULL for an INDEPENDENT expert — not an error. The view uses their own name.
      agencyName: null,
    });

    await db
      .update(expertProfiles)
      .set({ agencyId: agency.id })
      .where(eq(expertProfiles.id, expert.id));

    const withAgency = await captureHealthRepository.loadDetails([meetingId]);
    expect(withAgency.expert.get(meetingId)?.agencyName).toBe('CloudPeak');
  });

  it('resolves the CLIENT COMPANY through all three id-bearing context arms', async () => {
    const client = await companyFactory({ name: 'Northwind Industrial' });

    // ARM 1 — `case` → engagements.id
    const caseEngagement = await caseEngagementFactory({ companyId: client.id });
    const caseMeeting = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: caseEngagement.engagement.id }],
      values: { scheduledStart: at(5), scheduledEnd: new Date(at(5).getTime() + HOUR_MS) },
    });

    // ARM 2 — `project_discovery` → project_requests.id
    const request = await projectRequestFactory({ companyId: client.id });
    const discoveryMeeting = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
      values: { scheduledStart: at(6), scheduledEnd: new Date(at(6).getTime() + HOUR_MS) },
    });

    // ARM 3 — `request_interaction` → request_expert_relationships.id → project_requests.id
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
    });
    const interactionMeeting = await meetingFactory({
      contexts: [{ contextType: 'request_interaction', contextId: relationship.id }],
      values: { scheduledStart: at(7), scheduledEnd: new Date(at(7).getTime() + HOUR_MS) },
    });

    // ARM 4 — `admin` → NULL. No company, and that is a legitimate answer.
    const adminMeeting = await meetingFactory({
      contexts: [{ contextType: 'admin', contextId: null }],
      values: { scheduledStart: at(8), scheduledEnd: new Date(at(8).getTime() + HOUR_MS) },
    });

    const details = await captureHealthRepository.loadDetails([
      caseMeeting.meeting.id,
      discoveryMeeting.meeting.id,
      interactionMeeting.meeting.id,
      adminMeeting.meeting.id,
    ]);

    expect(details.party.get(caseMeeting.meeting.id)).toEqual({
      meetingId: caseMeeting.meeting.id,
      contextType: 'case',
      companyName: 'Northwind Industrial',
    });
    expect(details.party.get(discoveryMeeting.meeting.id)).toEqual({
      meetingId: discoveryMeeting.meeting.id,
      contextType: 'project_discovery',
      companyName: 'Northwind Industrial',
    });
    expect(details.party.get(interactionMeeting.meeting.id)).toEqual({
      meetingId: interactionMeeting.meeting.id,
      contextType: 'request_interaction',
      companyName: 'Northwind Industrial',
    });
    expect(details.party.get(adminMeeting.meeting.id)).toEqual({
      meetingId: adminMeeting.meeting.id,
      contextType: 'admin',
      companyName: null,
    });
  });

  it('⚠ THE PRECEDENCE PICK: a kickoff carrying BOTH discovery and kickoff reads as a kickoff', async () => {
    const { meetingId } = await seedDualContextMeeting();

    const details = await captureHealthRepository.loadDetails([meetingId]);

    expect(details.party.get(meetingId)?.contextType).toBe('project_kickoff');
    expect(details.party.get(meetingId)?.companyName).toBe('Northwind Industrial');
  });

  it('a soft-deleted context row does not win the precedence pick', async () => {
    const { meetingId, engagementId } = await seedDualContextMeeting();
    await db
      .update(meetingContexts)
      .set({ deletedAt: new Date() })
      .where(eq(meetingContexts.contextId, engagementId));

    const details = await captureHealthRepository.loadDetails([meetingId]);

    expect(details.party.get(meetingId)?.contextType).toBe('project_discovery');
  });
});
