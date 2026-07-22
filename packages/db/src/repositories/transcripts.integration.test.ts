import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { transcripts, engagements, type CanonicalTranscript } from '../schema';
import { engagementFactory, transcriptFactory } from '../test/factories';
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
    const meetingId = randomUUID();

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
    expect(created.recordingRef).toBeNull();
    expect(created.actionItemsExtractedAt).toBeNull();
    expect(created.recapReadyPublishedAt).toBeNull();
    expect(created.canonical.segments).toHaveLength(1);
  });

  it('is idempotent on capture_id — a second insert returns the SAME row (onConflictDoNothing)', async () => {
    const { engagement } = await engagementFactory();
    const captureId = `capture-${randomUUID()}`;

    const first = await transcriptsRepository.insertRaw({
      captureId,
      engagementId: engagement.id,
      vendor: 'recall',
      canonical: canonical(),
    });
    const second = await transcriptsRepository.insertRaw({
      captureId,
      engagementId: engagement.id,
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
      vendor: 'daily_deepgram',
      canonical: canonical(),
    });

    await db.delete(engagements).where(eq(engagements.id, engagement.id));

    const rows = await db.select().from(transcripts).where(eq(transcripts.id, created.id));
    expect(rows).toHaveLength(0);
  });
});
