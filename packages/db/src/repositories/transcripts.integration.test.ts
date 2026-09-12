import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  transcripts,
  transcriptArtifacts,
  engagements,
  meetings,
  projectEngagements,
  type CanonicalTranscript,
} from '../schema';
import {
  engagementFactory,
  meetingFactory,
  transcriptArtifactFactory,
  transcriptFactory,
} from '../test/factories';
import { transcriptsRepository } from './transcripts';

/** A minimal, valid canonical transcript for insertRaw. */
function canonical(): CanonicalTranscript {
  return {
    schemaVersion: 1,
    vendor: 'daily_deepgram',
    language: 'en',
    fillerWords: true,
    speakers: [{ ref: 'u1', displayName: 'Alice', userId: 'u1', source: 'authenticated' }],
    segments: [
      { index: 0, speakerRef: 'u1', startMs: 0, endMs: 1000, text: 'Hello', confidence: 0.9 },
    ],
    durationMs: 1000,
  };
}

describe('transcriptsRepository.insertRaw', () => {
  it('persists the raw canonical transcript with status=processing and filler_words=true', async () => {
    const { engagement } = await engagementFactory();
    const captureId = `capture-${randomUUID()}`;
    // BAL-418: `meeting_id` is a NOT NULL FK now — a bare `randomUUID()` violates it (23503).
    const meetingId = (await meetingFactory()).meeting.id;

    const created = await transcriptsRepository.insertRaw({
      captureId,
      engagementId: engagement.id,
      meetingId,
      vendor: 'daily_deepgram',
      canonical: canonical(),
      language: 'en',
      durationMs: 1000,
    });

    expect(created.captureId).toBe(captureId);
    expect(created.engagementId).toBe(engagement.id);
    expect(created.meetingId).toBe(meetingId);
    expect(created.vendor).toBe('daily_deepgram');
    expect(created.status).toBe('processing');
    expect(created.fillerWords).toBe(true);
    expect(created.actionItemsExtractedAt).toBeNull();
    expect(created.recapReadyPublishedAt).toBeNull();
    expect(created.canonical.segments).toHaveLength(1);
  });

  it('is idempotent on capture_id — a second insert returns the SAME row (onConflictDoNothing)', async () => {
    const { engagement } = await engagementFactory();
    const captureId = `capture-${randomUUID()}`;
    const meetingId = (await meetingFactory()).meeting.id;

    const first = await transcriptsRepository.insertRaw({
      captureId,
      engagementId: engagement.id,
      meetingId,
      vendor: 'recall',
      canonical: canonical(),
    });
    const second = await transcriptsRepository.insertRaw({
      captureId,
      engagementId: engagement.id,
      meetingId,
      vendor: 'recall',
      canonical: canonical(),
    });

    expect(second.id).toBe(first.id);
    const rows = await db.select().from(transcripts).where(eq(transcripts.captureId, captureId));
    expect(rows).toHaveLength(1);
  });
});

describe('transcriptsRepository.findByCaptureId / findById', () => {
  it('finds a live transcript by capture id and by id', async () => {
    const { transcript } = await transcriptFactory();

    const byCapture = await transcriptsRepository.findByCaptureId(transcript.captureId);
    expect(byCapture?.id).toBe(transcript.id);
    const byId = await transcriptsRepository.findById(transcript.id);
    expect(byId?.id).toBe(transcript.id);
  });

  it('returns undefined for a missing id and for a soft-deleted transcript', async () => {
    expect(await transcriptsRepository.findById(randomUUID())).toBeUndefined();
    const { transcript } = await transcriptFactory({ values: { deletedAt: new Date() } });
    expect(await transcriptsRepository.findById(transcript.id)).toBeUndefined();
    expect(await transcriptsRepository.findByCaptureId(transcript.captureId)).toBeUndefined();
  });
});

describe('transcriptsRepository stage markers', () => {
  it('setExtractedActionItems round-trips the extracted items on the row', async () => {
    const { transcript } = await transcriptFactory();

    const updated = await transcriptsRepository.setExtractedActionItems(transcript.id, [
      { body: 'Confirm the go-live date', assigneeParty: 'client', dueAt: null },
      { body: 'Assign a QA owner', assigneeParty: 'expert', dueAt: null },
    ]);
    expect(updated.extractedActionItems).toHaveLength(2);
    expect(updated.extractedActionItems?.map((i) => i.body)).toEqual([
      'Confirm the go-live date',
      'Assign a QA owner',
    ]);
    expect(updated.extractedActionItems?.map((i) => i.assigneeParty)).toEqual(['client', 'expert']);

    // Reload to prove it persisted, not just returned.
    const reloaded = await transcriptsRepository.findById(transcript.id);
    expect(reloaded?.extractedActionItems).toHaveLength(2);
  });

  it('markActionItemsExtracted stamps the extraction stage gate', async () => {
    const { transcript } = await transcriptFactory();
    expect(transcript.actionItemsExtractedAt).toBeNull();

    const updated = await transcriptsRepository.markActionItemsExtracted(transcript.id);
    expect(updated.actionItemsExtractedAt).toBeInstanceOf(Date);
  });

  it('markRecapPublished stamps the recap gate and flips status to ready', async () => {
    const { transcript } = await transcriptFactory();

    const updated = await transcriptsRepository.markRecapPublished(transcript.id);
    expect(updated.recapReadyPublishedAt).toBeInstanceOf(Date);
    expect(updated.status).toBe('ready');
  });

  it('markFailed records the failing stage + reason and flips status to failed', async () => {
    const { transcript } = await transcriptFactory();

    const updated = await transcriptsRepository.markFailed(transcript.id, 'summary', 'LLM timeout');
    expect(updated.failedStage).toBe('summary');
    expect(updated.failureReason).toBe('LLM timeout');
    expect(updated.status).toBe('failed');
  });

  it('recordStageSkip records the skip stage + reason but leaves status UNCHANGED', async () => {
    const { transcript } = await transcriptFactory();
    expect(transcript.status).toBe('processing');

    await transcriptsRepository.recordStageSkip(
      transcript.id,
      'extract_action_items',
      'engagement_not_active'
    );

    // Reload to prove the degradation persisted without flipping status (distinct from markFailed).
    const reloaded = await transcriptsRepository.findById(transcript.id);
    expect(reloaded?.failedStage).toBe('extract_action_items');
    expect(reloaded?.failureReason).toBe('engagement_not_active');
    expect(reloaded?.status).toBe('processing');
  });
});

describe('transcripts — engagement cascade', () => {
  it('a hard-deleted engagement cascades the transcript away (ON DELETE cascade)', async () => {
    const { engagement } = await engagementFactory();
    const created = await transcriptsRepository.insertRaw({
      captureId: `capture-${randomUUID()}`,
      engagementId: engagement.id,
      meetingId: (await meetingFactory()).meeting.id,
      vendor: 'daily_deepgram',
      canonical: canonical(),
    });

    await db.delete(engagements).where(eq(engagements.id, engagement.id));

    const rows = await db.select().from(transcripts).where(eq(transcripts.id, created.id));
    expect(rows).toHaveLength(0);

    // BAL-417: the `project_engagements` CHILD is cascaded too — the composite FK
    // `project_engagement_parent_type_fk` carries ON DELETE cascade.
    const childRows = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, engagement.id));
    expect(childRows).toHaveLength(0);
  });
});

/**
 * BAL-388 — the MEETING-scoped read the recap page needs. Before this, the only lookups were
 * by `capture_id` and by `id`, so "the transcript for this meeting" had no repository method
 * at all.
 */
describe('transcriptsRepository.findByMeetingId', () => {
  it('returns the LIVE transcript for a meeting, PROJECTED to id + status only', async () => {
    const { transcript, meetingId } = await transcriptFactory();

    const found = await transcriptsRepository.findByMeetingId(meetingId);
    expect(found?.id).toBe(transcript.id);
    expect(found?.status).toBe(transcript.status);
    // ⚠ THE KEY SET IS THE INVARIANT. `transcripts.canonical` holds the whole raw segment
    // array for the call; a bare `select()` pulled a potentially multi-hundred-KB jsonb on
    // EVERY recap render just to read one enum. A regression re-adds keys here.
    expect(Object.keys(found ?? {}).sort()).toEqual(['id', 'status']);
    expect(found).not.toHaveProperty('canonical');
    expect(found).not.toHaveProperty('extractedActionItems');
  });

  it('filters deleted_at IS NULL — a soft-deleted transcript is invisible', async () => {
    const { transcript, meetingId } = await transcriptFactory();
    await db
      .update(transcripts)
      .set({ deletedAt: new Date() })
      .where(eq(transcripts.id, transcript.id));

    await expect(transcriptsRepository.findByMeetingId(meetingId)).resolves.toBeUndefined();
  });

  it('returns undefined for a meeting with no transcript', async () => {
    const meetingId = (await meetingFactory()).meeting.id;
    await expect(transcriptsRepository.findByMeetingId(meetingId)).resolves.toBeUndefined();
  });

  it("never returns ANOTHER meeting's transcript", async () => {
    await transcriptFactory();
    const otherMeetingId = (await meetingFactory()).meeting.id;
    await expect(transcriptsRepository.findByMeetingId(otherMeetingId)).resolves.toBeUndefined();
  });

  it('picks the MOST RECENT row when a meeting somehow has two captures', async () => {
    // ⚠ `meeting_id` is NOT the partial-unique — `capture_id` is — so two captures of one
    // meeting ARE representable. The recap must not flip between two summaries on refresh,
    // so the order is deterministic rather than arbitrary.
    const { meetingId, engagementId } = await transcriptFactory({
      values: { createdAt: new Date('2026-07-01T00:00:00.000Z') },
    });
    const second = await transcriptFactory({
      meetingId,
      engagementId,
      values: { createdAt: new Date('2026-07-02T00:00:00.000Z') },
    });

    const found = await transcriptsRepository.findByMeetingId(meetingId);
    expect(found?.id).toBe(second.transcript.id);
  });
});

describe('transcriptsRepository.findByMeetingIds', () => {
  it('answers for MANY meetings in one call, keyed by meeting_id', async () => {
    const a = await transcriptFactory();
    const b = await transcriptFactory();

    const byMeetingId = await transcriptsRepository.findByMeetingIds([a.meetingId, b.meetingId]);
    expect(byMeetingId.size).toBe(2);
    expect(byMeetingId.get(a.meetingId)?.id).toBe(a.transcript.id);
    expect(byMeetingId.get(b.meetingId)?.id).toBe(b.transcript.id);
  });

  it('PROJECTS to id + status + meetingId — never the canonical jsonb', async () => {
    // Same invariant as the single-meeting reader: the batch exists to remove N queries, not
    // to reintroduce the multi-hundred-KB payload those queries were careful to avoid.
    const { meetingId } = await transcriptFactory();

    const found = (await transcriptsRepository.findByMeetingIds([meetingId])).get(meetingId);
    expect(Object.keys(found ?? {}).sort()).toEqual(['id', 'meetingId', 'status']);
    expect(found).not.toHaveProperty('canonical');
    expect(found).not.toHaveProperty('extractedActionItems');
  });

  it('AGREES WITH findByMeetingId when a meeting has two captures — newest wins', async () => {
    // The de-dup in the batch reader must reproduce the single reader's `limit(1)`, not
    // approximate it: a case surface and a recap disagreeing about which capture is current
    // is exactly the drift a batched read tends to introduce.
    const first = await transcriptFactory({
      values: { createdAt: new Date('2026-07-01T00:00:00.000Z') },
    });
    const second = await transcriptFactory({
      meetingId: first.meetingId,
      engagementId: first.engagementId,
      values: { createdAt: new Date('2026-07-02T00:00:00.000Z') },
    });

    const batched = (await transcriptsRepository.findByMeetingIds([first.meetingId])).get(
      first.meetingId
    );
    const single = await transcriptsRepository.findByMeetingId(first.meetingId);
    expect(batched?.id).toBe(second.transcript.id);
    expect(batched?.id).toBe(single?.id);
  });

  it('omits meetings with no transcript rather than mapping them to undefined', async () => {
    const { meetingId } = await transcriptFactory();
    const emptyMeetingId = (await meetingFactory()).meeting.id;

    const byMeetingId = await transcriptsRepository.findByMeetingIds([meetingId, emptyMeetingId]);
    expect(byMeetingId.has(meetingId)).toBe(true);
    expect(byMeetingId.has(emptyMeetingId)).toBe(false);
  });

  it('filters deleted_at IS NULL — a soft-deleted transcript is invisible', async () => {
    const { transcript, meetingId } = await transcriptFactory();
    await db
      .update(transcripts)
      .set({ deletedAt: new Date() })
      .where(eq(transcripts.id, transcript.id));

    const byMeetingId = await transcriptsRepository.findByMeetingIds([meetingId]);
    expect(byMeetingId.size).toBe(0);
  });

  it('short-circuits on an EMPTY id list without querying', async () => {
    // `inArray` with an empty list is a driver error in some stacks and a full scan in others;
    // neither is what a case with no ended consultations meant to ask for.
    await expect(transcriptsRepository.findByMeetingIds([])).resolves.toEqual(new Map());
  });
});

/**
 * BAL-548 / ADR-1055 — the `transcript.failed` finder read.
 *
 * ⚠ THE LOAD-BEARING CASE HERE IS THE `recordStageSkip` ROW. `transcript_failed_idx` is the
 * columns-only `failed_stage IS NOT NULL` superset, and `recordStageSkip` stamps a stage on a
 * DEGRADED-BUT-COMPLETED row. Without the read's explicit `status = 'failed'` term every
 * recorded skip would surface in the admin queue as a failure — so that case is not colour,
 * it is the reason the term exists.
 *
 * ⚠⚠ THE READ ALSO CARRIES `failed_stage IS NOT NULL` — a SECOND term, not a stand-in for the
 * first. Without it, Postgres cannot prove `status = 'failed'` implies the index's predicate
 * and will not use `transcript_failed_idx` (a correctness-invisible perf regression: a
 * `status = 'failed'`-only read still returns the right rows, it just seq-scans to get them).
 * No production writer leaves `status = 'failed'` with a null `failed_stage` today
 * (`markFailed` always stamps both together), so the case below is a synthetic row seeded
 * directly, proving the read's own predicate — not just today's writer behaviour.
 */
describe('transcriptsRepository.listFailedSince', () => {
  async function seedFailed(createdAt: Date) {
    const { transcript, meetingId } = await transcriptFactory({
      values: {
        status: 'failed',
        failedStage: 'summary',
        failureReason: 'the model refused',
        createdAt,
      },
    });
    return { transcriptId: transcript.id, meetingId };
  }

  it('returns failed transcripts OLDEST FIRST, with the meeting projected', async () => {
    const older = await seedFailed(new Date('2026-01-01T00:00:00.000Z'));
    const newer = await seedFailed(new Date('2026-01-02T00:00:00.000Z'));

    const rows = await transcriptsRepository.listFailedSince(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );
    const mine = rows.filter((row) =>
      [older.transcriptId, newer.transcriptId].includes(row.transcriptId)
    );

    expect(mine.map((row) => row.transcriptId)).toEqual([older.transcriptId, newer.transcriptId]);
    const [first] = mine;
    expect(first?.meetingId).toBe(older.meetingId);
    expect(first?.failedStage).toBe('summary');
    expect(first?.failureReason).toBe('the model refused');
    expect(first?.meetingScheduledStart).toBeInstanceOf(Date);
  });

  it('⚠ EXCLUDES a recordStageSkip row — a stamped failed_stage on a COMPLETED transcript is not a failure', async () => {
    const { transcript } = await transcriptFactory({
      values: { status: 'ready', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    // The real degraded-but-completed path: stamps `failed_stage` and leaves `status` alone.
    await transcriptsRepository.recordStageSkip(
      transcript.id,
      'action_items',
      'engagement not active'
    );

    const rows = await transcriptsRepository.listFailedSince(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );

    // It carries a `failed_stage`, so the INDEX predicate matches it — only the read's
    // explicit `status = 'failed'` term keeps it out of the queue.
    const [raw] = await db.select().from(transcripts).where(eq(transcripts.id, transcript.id));
    expect(raw?.failedStage).toBe('action_items');
    expect(raw?.status).toBe('ready');
    expect(rows.map((row) => row.transcriptId)).not.toContain(transcript.id);
  });

  it('⚠ EXCLUDES a status=failed row with a NULL failed_stage — the added index-usability term', async () => {
    // No real writer produces this shape today (`markFailed` always stamps both together),
    // but the read's own `failed_stage IS NOT NULL` predicate must hold it out regardless —
    // seeded directly rather than through the repository to prove the read, not the writer.
    const { transcript } = await transcriptFactory({
      values: {
        status: 'failed',
        failedStage: null,
        failureReason: 'seeded without a stage',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    const rows = await transcriptsRepository.listFailedSince(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );

    expect(rows.map((row) => row.transcriptId)).not.toContain(transcript.id);
  });

  it('includes only rows carrying BOTH status=failed and a non-null failed_stage', async () => {
    const both = await seedFailed(new Date('2026-01-01T00:00:00.000Z'));
    const { transcript: statusOnly } = await transcriptFactory({
      values: {
        status: 'failed',
        failedStage: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const { transcript: stageOnly } = await transcriptFactory({
      values: { status: 'ready', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    await transcriptsRepository.recordStageSkip(stageOnly.id, 'action_items', 'skipped');

    const rows = await transcriptsRepository.listFailedSince(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );
    const ids = rows.map((row) => row.transcriptId);

    expect(ids).toContain(both.transcriptId);
    expect(ids).not.toContain(statusOnly.id);
    expect(ids).not.toContain(stageOnly.id);
  });

  it('excludes soft-deleted transcripts and transcripts of a soft-deleted meeting', async () => {
    const live = await seedFailed(new Date('2026-01-01T00:00:00.000Z'));
    const deleted = await seedFailed(new Date('2026-01-01T00:00:00.000Z'));
    const orphaned = await seedFailed(new Date('2026-01-01T00:00:00.000Z'));
    await db
      .update(transcripts)
      .set({ deletedAt: new Date() })
      .where(eq(transcripts.id, deleted.transcriptId));
    await db
      .update(meetings)
      .set({ deletedAt: new Date() })
      .where(eq(meetings.id, orphaned.meetingId));

    const rows = await transcriptsRepository.listFailedSince(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );
    const ids = rows.map((row) => row.transcriptId);

    expect(ids).toContain(live.transcriptId);
    expect(ids).not.toContain(deleted.transcriptId);
    expect(ids).not.toContain(orphaned.transcriptId);
  });

  it('the cutoff excludes a too-recent failure, and the limit bounds the batch', async () => {
    const old = await seedFailed(new Date('2026-01-01T00:00:00.000Z'));
    const recent = await seedFailed(new Date('2026-01-10T00:00:00.000Z'));

    const beforeCutoff = await transcriptsRepository.listFailedSince(
      new Date('2026-01-05T00:00:00.000Z'),
      50
    );
    expect(beforeCutoff.map((row) => row.transcriptId)).toContain(old.transcriptId);
    expect(beforeCutoff.map((row) => row.transcriptId)).not.toContain(recent.transcriptId);

    const bounded = await transcriptsRepository.listFailedSince(
      new Date('2026-02-01T00:00:00.000Z'),
      1
    );
    expect(bounded).toHaveLength(1);
  });
});

// ── claimRecapResume (BAL-550 / D5) ──────────────────────────────────────────

/**
 * THE RECAP RE-DRIVE'S CLAIM. `failed → processing`, clearing the stage + reason.
 *
 * ⚠ THE HARNESS `db` **IS** THE PER-TEST TRANSACTION, so it satisfies the `DbExecutor` this
 * mutator demands. That is not a loophole: the executor is required so a PRODUCTION caller
 * cannot commit the state change outside the `audit_events` row's transaction, and a test
 * handing over the transaction it is already inside is exactly the intended usage (the
 * `meeting-recordings.integration.test.ts` note, restated).
 *
 * ⚠ EVERY REFUSAL RETURNS `undefined` RATHER THAN THROWING, so several can share one `it`
 * without aborting the harness transaction (`25P02`).
 */
describe('transcriptsRepository.claimRecapResume', () => {
  it('moves failed → processing and NULLs failed_stage / failure_reason', async () => {
    const { transcript } = await transcriptFactory({
      values: { status: 'failed', failedStage: 'summarize', failureReason: 'llm timed out' },
    });

    const claimed = await transcriptsRepository.claimRecapResume(transcript.id, db);

    expect(claimed).toBeDefined();
    expect(claimed?.status).toBe('processing');
    expect(claimed?.failedStage).toBeNull();
    expect(claimed?.failureReason).toBeNull();
  });

  it('⚠⚠ RESETS NO STAGE GATE — artifacts, extraction and publish stamps survive verbatim', async () => {
    const publishedAt = new Date('2026-03-01T10:00:00.000Z');
    const extractedAt = new Date('2026-03-01T09:00:00.000Z');
    const { transcript } = await transcriptFactory({
      values: {
        status: 'failed',
        failedStage: 'publish_recap',
        failureReason: 'engine refused',
        extractedActionItems: [
          { body: 'Send the migration plan', assigneeParty: 'expert', dueAt: null },
        ],
        actionItemsExtractedAt: extractedAt,
        recapReadyPublishedAt: publishedAt,
      },
    });
    await transcriptArtifactFactory({ transcriptId: transcript.id, values: { kind: 'cleaned' } });
    await transcriptArtifactFactory({
      transcriptId: transcript.id,
      values: { kind: 'summary', content: 'A summary.' },
    });

    const claimed = await transcriptsRepository.claimRecapResume(transcript.id, db);

    // The three columns the CLAIM writes.
    expect(claimed?.status).toBe('processing');
    expect(claimed?.failedStage).toBeNull();
    expect(claimed?.failureReason).toBeNull();
    // ⚠ EVERYTHING BAL-387's PER-STAGE GATES READ IS UNTOUCHED — this is what makes "a re-run
    // re-spends no LLM budget and re-creates no action item" true rather than aspirational.
    expect(claimed?.recapReadyPublishedAt?.toISOString()).toBe(publishedAt.toISOString());
    expect(claimed?.actionItemsExtractedAt?.toISOString()).toBe(extractedAt.toISOString());
    expect(claimed?.extractedActionItems).toEqual(transcript.extractedActionItems);
    const artifacts = await db
      .select()
      .from(transcriptArtifacts)
      .where(eq(transcriptArtifacts.transcriptId, transcript.id));
    expect(artifacts.map((row) => row.kind).sort((a, b) => a.localeCompare(b))).toEqual([
      'cleaned',
      'summary',
    ]);
  });

  it('REFUSES every wrong prior state: processing, ready, and a `failed` row with no stage', async () => {
    const { transcript: processing } = await transcriptFactory({
      values: { status: 'processing' },
    });
    const { transcript: ready } = await transcriptFactory({ values: { status: 'ready' } });
    // `failed` with NO recorded stage — there is nothing to resume from, and the read that
    // finds these rows carries `failed_stage IS NOT NULL` for the same reason.
    const { transcript: stageless } = await transcriptFactory({ values: { status: 'failed' } });

    expect(await transcriptsRepository.claimRecapResume(processing.id, db)).toBeUndefined();
    expect(await transcriptsRepository.claimRecapResume(ready.id, db)).toBeUndefined();
    expect(await transcriptsRepository.claimRecapResume(stageless.id, db)).toBeUndefined();
  });

  it('⚠⚠ REFUSES A PARTIAL RECAP (`ready` + failed_stage) — a skip is not a failure', async () => {
    // `recordStageSkip` writes exactly this shape on a DEGRADED-BUT-COMPLETED path. Re-driving
    // it would re-enter a pipeline that already published, and the lens never shows it as
    // failed in the first place.
    const { transcript } = await transcriptFactory({ values: { status: 'ready' } });
    await transcriptsRepository.recordStageSkip(transcript.id, 'action_items', 'engagement ended');

    expect(await transcriptsRepository.claimRecapResume(transcript.id, db)).toBeUndefined();
  });

  it('REFUSES a soft-deleted transcript', async () => {
    const { transcript } = await transcriptFactory({
      values: {
        status: 'failed',
        failedStage: 'cleanup',
        failureReason: 'x',
        deletedAt: new Date(),
      },
    });

    expect(await transcriptsRepository.claimRecapResume(transcript.id, db)).toBeUndefined();
  });

  /**
   * ⚠⚠ A LIVE TRANSCRIPT ON A SOFT-DELETED MEETING. Its own `deleted_at` is null, so every
   * other term of the CAS passes — the `EXISTS` on `meetings` is the only thing refusing it.
   * Such a row is never rendered (the lens's windowed read filters `meetings.deleted_at`), so
   * a hand-crafted request is the only way to reach it; it matters because a successful resume
   * ends in `stagePublishRecap` firing `recap.ready` to BOTH PARTIES about a consultation the
   * platform considers deleted.
   */
  it('REFUSES a live transcript whose MEETING has been soft-deleted', async () => {
    const { transcript } = await transcriptFactory({
      values: { status: 'failed', failedStage: 'summarize', failureReason: 'llm timed out' },
    });
    await db
      .update(meetings)
      .set({ deletedAt: new Date() })
      .where(eq(meetings.id, transcript.meetingId));

    expect(await transcriptsRepository.claimRecapResume(transcript.id, db)).toBeUndefined();
  });

  it('THE DOUBLE-CLICK GUARD: the second claim against the same row matches nothing', async () => {
    const { transcript } = await transcriptFactory({
      values: { status: 'failed', failedStage: 'summarize', failureReason: 'boom' },
    });

    expect(await transcriptsRepository.claimRecapResume(transcript.id, db)).toBeDefined();
    // The row is `processing` now, so the CAS matches zero rows — which is what makes the
    // route write ONE audit row and enqueue ONE job for two clicks.
    expect(await transcriptsRepository.claimRecapResume(transcript.id, db)).toBeUndefined();
  });
});
