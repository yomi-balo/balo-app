import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngagementNotActiveError } from '@balo/db';
import { runTranscriptPipeline, type TranscriptPipelineJobInput } from './pipeline.js';
import type { LlmAudit, LlmClient } from './llm/types.js';
import { dailyMultiSpeaker } from './normalizers/__fixtures__/daily-deepgram.js';

// ── Hoisted mock fns ───────────────────────────────────────────────────────────
const db = vi.hoisted(() => ({
  findByCaptureId: vi.fn(),
  insertRaw: vi.fn(),
  setExtractedActionItems: vi.fn(),
  markActionItemsExtracted: vi.fn(),
  markRecapPublished: vi.fn(),
  findByTranscriptAndKind: vi.fn(),
  upsert: vi.fn(),
  createFromExtraction: vi.fn(),
  findEngagementById: vi.fn(),
  findOwnerByCompanyId: vi.fn(),
}));
const publish = vi.hoisted(() => vi.fn());
const trackServer = vi.hoisted(() => vi.fn());

vi.mock('@balo/db', () => {
  class EngagementNotActiveError extends Error {}
  return {
    transcriptsRepository: {
      findByCaptureId: db.findByCaptureId,
      insertRaw: db.insertRaw,
      setExtractedActionItems: db.setExtractedActionItems,
      markActionItemsExtracted: db.markActionItemsExtracted,
      markRecapPublished: db.markRecapPublished,
    },
    transcriptArtifactsRepository: {
      findByTranscriptAndKind: db.findByTranscriptAndKind,
      upsert: db.upsert,
    },
    actionItemsRepository: { createFromExtraction: db.createFromExtraction },
    engagementsRepository: { findById: db.findEngagementById },
    companiesRepository: { findOwnerByCompanyId: db.findOwnerByCompanyId },
    EngagementNotActiveError,
  };
});

vi.mock('../../notifications/index.js', () => ({ notificationEvents: { publish } }));

vi.mock('@balo/analytics/server', () => ({
  trackServer,
  TRANSCRIPT_SERVER_EVENTS: {
    TRANSCRIPT_READY: 'transcript_ready',
    SUMMARY_READY: 'summary_ready',
    BOT_JOIN_FAILED: 'bot_join_failed',
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────
const makeAudit = (promptId: string): LlmAudit => ({
  provider: 'anthropic',
  modelId: 'noop',
  modelVersion: null,
  promptId,
  promptVersion: 'v1',
  prompt: 'rendered',
});

const fakeLlm: LlmClient = {
  cleanupTranscript: vi
    .fn()
    .mockResolvedValue({ text: 'CLEANED', audit: makeAudit('transcript.cleanup') }),
  summarize: vi.fn().mockResolvedValue({
    summary: 'Recap headline\ndetails',
    audit: makeAudit('transcript.summary'),
  }),
  extractActionItems: vi.fn().mockResolvedValue({
    items: [{ body: 'Do X', assigneeParty: 'client', dueAt: null }],
    audit: makeAudit('transcript.extract'),
  }),
};

function makeTranscript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tr1',
    engagementId: 'eng1',
    meetingId: null,
    vendor: 'daily_deepgram',
    extractedActionItems: null,
    actionItemsExtractedAt: null,
    recapReadyPublishedAt: null,
    recordingRef: null,
    ...overrides,
  };
}

const job: TranscriptPipelineJobInput = {
  captureId: 'cap1',
  engagementId: 'eng1',
  meetingId: null,
  vendor: 'daily_deepgram',
  payload: dailyMultiSpeaker,
  recordingRef: null,
  durationMs: 12500,
};

/** Wire the happy-path (all stages fresh) mock behavior. Tests override specifics after. */
function setupFreshRun(): void {
  db.findByCaptureId.mockResolvedValue(undefined); // newly created
  db.insertRaw.mockResolvedValue(makeTranscript() as never);
  db.findByTranscriptAndKind.mockResolvedValue(undefined); // no cleaned / summary artifact yet
  db.upsert.mockImplementation(
    async (input: { content: string }) => ({ content: input.content }) as never
  );
  db.setExtractedActionItems.mockResolvedValue(makeTranscript() as never);
  db.createFromExtraction.mockResolvedValue([] as never);
  db.markActionItemsExtracted.mockResolvedValue(makeTranscript() as never);
  db.findEngagementById.mockResolvedValue({ companyId: 'co1', expertProfileId: 'exp1' } as never);
  db.findOwnerByCompanyId.mockResolvedValue({ id: 'owner1' } as never);
  db.markRecapPublished.mockResolvedValue(makeTranscript() as never);
  publish.mockResolvedValue(undefined);
}

describe('runTranscriptPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs all six stages on a fresh capture and fires recap.ready to both parties', async () => {
    setupFreshRun();

    await runTranscriptPipeline(job, { llm: fakeLlm });

    // Stage 2 — persist raw + transcript_ready (newly created)
    expect(db.insertRaw).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: 'cap1', engagementId: 'eng1', vendor: 'daily_deepgram' })
    );
    expect(trackServer).toHaveBeenCalledWith(
      'transcript_ready',
      expect.objectContaining({ engagement_id: 'eng1', vendor: 'daily_deepgram', segment_count: 3 })
    );

    // Stage 3 — cleanup
    expect(fakeLlm.cleanupTranscript).toHaveBeenCalledTimes(1);
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cleaned', content: 'CLEANED' })
    );

    // Stage 4 — summary + extraction + summary_ready
    expect(fakeLlm.summarize).toHaveBeenCalledTimes(1);
    expect(fakeLlm.extractActionItems).toHaveBeenCalledTimes(1);
    expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'summary' }));
    expect(db.setExtractedActionItems).toHaveBeenCalledWith('tr1', [
      { body: 'Do X', assigneeParty: 'client', dueAt: null },
    ]);
    expect(trackServer).toHaveBeenCalledWith(
      'summary_ready',
      expect.objectContaining({ engagement_id: 'eng1', action_item_count: 1 })
    );

    // Stage 5 — promote action items
    expect(db.createFromExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        engagementId: 'eng1',
        actorUserId: null,
        items: [{ body: 'Do X', assigneeParty: 'client', dueAt: null }],
      })
    );
    expect(db.markActionItemsExtracted).toHaveBeenCalledWith('tr1');

    // Stage 6 — publish recap + mark
    expect(publish).toHaveBeenCalledWith(
      'recap.ready',
      expect.objectContaining({
        correlationId: 'tr1:recap_ready',
        engagementId: 'eng1',
        transcriptId: 'tr1',
        expertProfileId: 'exp1',
        recipientId: 'owner1',
        actionItemCount: 1,
        summaryHeadline: 'Recap headline',
      })
    );
    expect(db.markRecapPublished).toHaveBeenCalledWith('tr1');
  });

  it('short-circuits every stage on a re-run (idempotent — no LLM re-spend, no duplicate publish)', async () => {
    setupFreshRun();
    // Retry: the transcript + artifacts + stage markers already exist.
    const settled = makeTranscript({
      extractedActionItems: [{ body: 'Do X', assigneeParty: 'client', dueAt: null }],
      actionItemsExtractedAt: new Date(),
      recapReadyPublishedAt: new Date(),
    });
    db.findByCaptureId.mockResolvedValue(settled as never); // existingBefore defined → not newly created
    db.insertRaw.mockResolvedValue(settled as never);
    db.findByTranscriptAndKind.mockResolvedValue({ content: 'existing' } as never);

    await runTranscriptPipeline(job, { llm: fakeLlm });

    expect(trackServer).not.toHaveBeenCalledWith('transcript_ready', expect.anything());
    expect(fakeLlm.cleanupTranscript).not.toHaveBeenCalled();
    expect(fakeLlm.summarize).not.toHaveBeenCalled();
    expect(db.setExtractedActionItems).not.toHaveBeenCalled();
    expect(db.createFromExtraction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(db.markRecapPublished).not.toHaveBeenCalled();
  });

  it('handles EngagementNotActiveError as a terminal skip and still publishes the recap', async () => {
    setupFreshRun();
    db.createFromExtraction.mockRejectedValue(new EngagementNotActiveError('eng1', 'completed'));

    await expect(runTranscriptPipeline(job, { llm: fakeLlm })).resolves.toBeUndefined();

    // Gate stamped anyway (no infinite retry); items retained on the row.
    expect(db.markActionItemsExtracted).toHaveBeenCalledWith('tr1');
    // Recap still fires.
    expect(publish).toHaveBeenCalledWith(
      'recap.ready',
      expect.objectContaining({ transcriptId: 'tr1' })
    );
  });

  it('rethrows a non-terminal stage failure as a TranscriptStageError (BullMQ retries)', async () => {
    setupFreshRun();
    db.upsert.mockRejectedValue(new Error('db down'));

    await expect(runTranscriptPipeline(job, { llm: fakeLlm })).rejects.toMatchObject({
      name: 'TranscriptStageError',
      stage: 'cleanup',
    });
  });
});
