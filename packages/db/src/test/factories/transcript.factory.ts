import { randomUUID } from 'node:crypto';
import { db } from '../../client';
import { transcripts, transcriptArtifacts } from '../../schema';
import type {
  Transcript,
  NewTranscript,
  TranscriptArtifact,
  NewTranscriptArtifact,
  CanonicalTranscript,
} from '../../schema';
import { engagementFactory } from './engagement.factory';

/** A minimal, valid two-speaker canonical transcript (the NOT NULL `canonical` jsonb default). */
function minimalCanonical(): CanonicalTranscript {
  return {
    schemaVersion: 1,
    vendor: 'daily_deepgram',
    language: 'en',
    fillerWords: true,
    speakers: [
      { ref: 'u1', displayName: 'Alice', userId: 'u1', source: 'authenticated' },
      { ref: 'u2', displayName: 'Bob', userId: 'u2', source: 'authenticated' },
    ],
    segments: [
      { index: 0, speakerRef: 'u1', startMs: 0, endMs: 1000, text: 'Hello', confidence: 0.9 },
      {
        index: 1,
        speakerRef: 'u2',
        startMs: 1000,
        endMs: 2000,
        text: 'Hi there',
        confidence: 0.88,
      },
    ],
    durationMs: 2000,
  };
}

interface TranscriptFactoryOverrides {
  /** Reuse an existing engagement instead of seeding a fresh active one. */
  engagementId?: string;
  /** Row-level overrides (captureId, vendor, status, meetingId, canonical, deletedAt, …). */
  values?: Partial<NewTranscript>;
}

export interface TranscriptFactoryResult {
  transcript: Transcript;
  engagementId: string;
}

/**
 * Seeds one `transcripts` row (default `vendor='daily_deepgram'`, `status='processing'`,
 * a valid minimal `canonical`, a fresh unique `captureId`) under an active engagement.
 * Inserts directly via `db` (not the repository) so tests can seed ANY vendor/status/
 * deleted combination. Overrides flow through `.values(...)`.
 */
export async function transcriptFactory(
  overrides: TranscriptFactoryOverrides = {}
): Promise<TranscriptFactoryResult> {
  const engagementId = overrides.engagementId ?? (await engagementFactory()).engagement.id;

  const [transcript] = await db
    .insert(transcripts)
    .values({
      engagementId,
      captureId: `capture-${randomUUID()}`,
      vendor: 'daily_deepgram',
      canonical: minimalCanonical(),
      ...overrides.values,
    })
    .returning();
  if (transcript === undefined) {
    throw new Error('transcript insert failed');
  }

  return { transcript, engagementId };
}

interface TranscriptArtifactFactoryOverrides {
  /** Reuse an existing transcript instead of seeding a fresh one. */
  transcriptId?: string;
  /** Row-level overrides (kind, content, modelId, prompt, deletedAt, …). */
  values?: Partial<NewTranscriptArtifact>;
}

export interface TranscriptArtifactFactoryResult {
  artifact: TranscriptArtifact;
  transcriptId: string;
}

/**
 * Seeds one `transcript_artifacts` row (default `kind='cleaned'` with valid minimal LLM
 * audit provenance) under a transcript. Seeds a fresh transcript via `transcriptFactory`
 * when no `transcriptId` is passed. Overrides flow through `.values(...)`.
 */
export async function transcriptArtifactFactory(
  overrides: TranscriptArtifactFactoryOverrides = {}
): Promise<TranscriptArtifactFactoryResult> {
  const transcriptId = overrides.transcriptId ?? (await transcriptFactory()).transcript.id;

  const [artifact] = await db
    .insert(transcriptArtifacts)
    .values({
      transcriptId,
      kind: 'cleaned',
      content: 'Cleaned transcript text.',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      promptId: 'transcript.cleanup',
      promptVersion: 'v1',
      prompt: 'Normalize disfluencies while preserving meaning and speaker turns.',
      ...overrides.values,
    })
    .returning();
  if (artifact === undefined) {
    throw new Error('transcript artifact insert failed');
  }

  return { artifact, transcriptId };
}
