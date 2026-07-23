import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { transcriptArtifacts, transcripts } from '../schema';
import { transcriptFactory } from '../test/factories';
import { transcriptArtifactsRepository } from './transcript-artifacts';

/** The full audit-provenance input for a summary artifact. */
function summaryInput(transcriptId: string) {
  return {
    transcriptId,
    kind: 'summary' as const,
    content: 'A concise recap of the consultation.',
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    modelVersion: 'claude-sonnet-5-20260101',
    promptId: 'transcript.summary',
    promptVersion: 'v1',
    prompt: 'Summarize the consultation for both parties.',
  };
}

describe('transcriptArtifactsRepository.upsert', () => {
  it('creates a cleaned artifact and persists its LLM audit provenance', async () => {
    const { transcript } = await transcriptFactory();

    const artifact = await transcriptArtifactsRepository.upsert({
      transcriptId: transcript.id,
      kind: 'cleaned',
      content: 'Cleaned full text.',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      modelVersion: 'claude-sonnet-5-20260101',
      promptId: 'transcript.cleanup',
      promptVersion: 'v1',
      prompt: 'Normalize disfluencies while preserving meaning.',
    });

    expect(artifact.kind).toBe('cleaned');
    expect(artifact.content).toBe('Cleaned full text.');
    expect(artifact.provider).toBe('anthropic');
    expect(artifact.modelId).toBe('claude-sonnet-5');
    expect(artifact.modelVersion).toBe('claude-sonnet-5-20260101');
    expect(artifact.promptId).toBe('transcript.cleanup');
    expect(artifact.promptVersion).toBe('v1');
    expect(artifact.prompt).toBe('Normalize disfluencies while preserving meaning.');

    // Re-read to prove the audit meta persisted (not just returned).
    const reloaded = await transcriptArtifactsRepository.findByTranscriptAndKind(
      transcript.id,
      'cleaned'
    );
    expect(reloaded?.modelId).toBe('claude-sonnet-5');
    expect(reloaded?.modelVersion).toBe('claude-sonnet-5-20260101');
    expect(reloaded?.prompt).toBe('Normalize disfluencies while preserving meaning.');
  });

  it('leaves modelVersion null when not supplied', async () => {
    const { transcript } = await transcriptFactory();
    const artifact = await transcriptArtifactsRepository.upsert({
      transcriptId: transcript.id,
      kind: 'summary',
      content: '',
      provider: 'noop',
      modelId: 'noop',
      promptId: 'transcript.summary',
      promptVersion: 'v1',
      prompt: '(noop passthrough)',
    });
    expect(artifact.modelVersion).toBeNull();
    // Noop path may write empty content — no non-empty CHECK.
    expect(artifact.content).toBe('');
  });

  it('is idempotent per (transcript_id, kind) — a second upsert returns the FIRST row', async () => {
    const { transcript } = await transcriptFactory();

    const first = await transcriptArtifactsRepository.upsert(summaryInput(transcript.id));
    const second = await transcriptArtifactsRepository.upsert({
      ...summaryInput(transcript.id),
      content: 'A DIFFERENT summary that must be ignored.',
    });

    expect(second.id).toBe(first.id);
    expect(second.content).toBe('A concise recap of the consultation.'); // first write wins
    const rows = await db
      .select()
      .from(transcriptArtifacts)
      .where(eq(transcriptArtifacts.transcriptId, transcript.id));
    expect(rows).toHaveLength(1);
  });

  it('allows both kinds to coexist for one transcript', async () => {
    const { transcript } = await transcriptFactory();
    await transcriptArtifactsRepository.upsert({
      transcriptId: transcript.id,
      kind: 'cleaned',
      content: 'Cleaned.',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      promptId: 'transcript.cleanup',
      promptVersion: 'v1',
      prompt: 'Cleanup prompt.',
    });
    await transcriptArtifactsRepository.upsert(summaryInput(transcript.id));

    const all = await transcriptArtifactsRepository.findByTranscript(transcript.id);
    expect(all.map((a) => a.kind).sort()).toEqual(['cleaned', 'summary']);
  });
});

describe('transcriptArtifactsRepository.findByTranscriptAndKind', () => {
  it('returns undefined for a kind that has no artifact yet (the stage gate read)', async () => {
    const { transcript } = await transcriptFactory();
    expect(
      await transcriptArtifactsRepository.findByTranscriptAndKind(transcript.id, 'summary')
    ).toBeUndefined();
    expect(
      await transcriptArtifactsRepository.findByTranscriptAndKind(randomUUID(), 'cleaned')
    ).toBeUndefined();
  });
});

describe('transcript_artifacts — transcript cascade', () => {
  it('a hard-deleted transcript cascades its artifacts away (ON DELETE cascade)', async () => {
    const { transcript } = await transcriptFactory();
    const artifact = await transcriptArtifactsRepository.upsert(summaryInput(transcript.id));

    await db.delete(transcripts).where(eq(transcripts.id, transcript.id));

    const rows = await db
      .select()
      .from(transcriptArtifacts)
      .where(eq(transcriptArtifacts.id, artifact.id));
    expect(rows).toHaveLength(0);
  });
});
