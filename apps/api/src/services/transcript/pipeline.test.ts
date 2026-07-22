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
  markFailed: vi.fn(),
  recordStageSkip: vi.fn(),
  findByTranscriptAndKind: vi.fn(),
  upsert: vi.fn(),
  createFromExtraction: vi.fn(),
  findEngagementById: vi.fn(),
  findOwnerUserIdByCompanyId: vi.fn(),
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
      markFailed: db.markFailed,
      recordStageSkip: db.recordStageSkip,
    },
    transcriptArtifactsRepository: {
      findByTranscriptAndKind: db.findByTranscriptAndKind,
      upsert: db.upsert,
    },
    actionItemsRepository: { createFromExtraction: db.createFromExtraction },
    engagementsRepository: { findById: db.findEngagementById },
    companiesRepository: { findOwnerUserIdByCompanyId: db.findOwnerUserIdByCompanyId },
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
    TRANSCRIPT_FAILED: 'transcript_failed',
    SUMMARY_HEADLINE_SUPPRESSED: 'summary_headline_suppressed',
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
  db.recordStageSkip.mockResolvedValue(undefined);
  db.markFailed.mockResolvedValue(makeTranscript() as never);
  db.findEngagementById.mockResolvedValue({ companyId: 'co1', expertProfileId: 'exp1' } as never);
  db.findOwnerUserIdByCompanyId.mockResolvedValue('owner1' as never);
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

    // ADR-1030 observability: the skip is recorded (status UNCHANGED) + the failure analytic fires.
    expect(db.recordStageSkip).toHaveBeenCalledWith(
      'tr1',
      'extract_action_items',
      'engagement_not_active'
    );
    expect(trackServer).toHaveBeenCalledWith('transcript_failed', {
      stage: 'extract_action_items',
      vendor: 'daily_deepgram',
      distinct_id: 'system:transcript-pipeline',
    });
    // Gate stamped anyway (no infinite retry); items retained on the row.
    expect(db.markActionItemsExtracted).toHaveBeenCalledWith('tr1');
    // Recap still fires (partial degradation, not a terminal failure).
    expect(publish).toHaveBeenCalledWith(
      'recap.ready',
      expect.objectContaining({ transcriptId: 'tr1' })
    );
    expect(db.markRecapPublished).toHaveBeenCalledWith('tr1');
  });

  it('marks the transcript failed + emits transcript_failed when the engagement is not found (no publish)', async () => {
    setupFreshRun();
    db.findEngagementById.mockResolvedValue(undefined); // engagement gone → recap undeliverable

    await expect(runTranscriptPipeline(job, { llm: fakeLlm })).resolves.toBeUndefined();

    // Genuine terminal failure: status='failed' is honest, nothing published, recap NOT stamped.
    expect(db.markFailed).toHaveBeenCalledWith('tr1', 'publish_recap', 'engagement_not_found');
    expect(trackServer).toHaveBeenCalledWith('transcript_failed', {
      stage: 'publish_recap',
      vendor: 'daily_deepgram',
      distinct_id: 'system:transcript-pipeline',
    });
    expect(publish).not.toHaveBeenCalled();
    expect(db.markRecapPublished).not.toHaveBeenCalled();
  });

  it('rethrows a non-terminal stage failure as a TranscriptStageError (BullMQ retries)', async () => {
    setupFreshRun();
    db.upsert.mockRejectedValue(new Error('db down'));

    await expect(runTranscriptPipeline(job, { llm: fakeLlm })).rejects.toMatchObject({
      name: 'TranscriptStageError',
      stage: 'cleanup',
    });
  });

  it('resume path: a stored ISO dueAt is parsed to a real Date at the promotion boundary', async () => {
    setupFreshRun();
    // Stage 4 already ran: the row carries the extracted items (dueAt as the stored ISO string,
    // NOT a Date) and the summary artifact exists, so summary/extraction short-circuit and the
    // items are re-read from the row — the previously-unexercised resume path.
    const resumed = makeTranscript({
      extractedActionItems: [{ body: 'Do X', assigneeParty: 'client', dueAt: '2026-08-01' }],
      actionItemsExtractedAt: null,
      recapReadyPublishedAt: null,
    });
    db.findByCaptureId.mockResolvedValue(resumed as never);
    db.insertRaw.mockResolvedValue(resumed as never);
    db.findByTranscriptAndKind.mockResolvedValue({ content: 'Recap headline\ndetails' } as never);

    let promotedDueAt: unknown;
    db.createFromExtraction.mockImplementation(
      async (arg: { items: Array<{ dueAt: unknown }> }) => {
        const [firstItem] = arg.items;
        promotedDueAt = firstItem?.dueAt;
        return [] as never;
      }
    );

    await runTranscriptPipeline(job, { llm: fakeLlm });

    // The LLM is not re-spent for extraction on the resume path.
    expect(fakeLlm.extractActionItems).not.toHaveBeenCalled();
    // The stored ISO string is parsed to a real Date at the createFromExtraction boundary.
    expect(promotedDueAt).toBeInstanceOf(Date);
    expect(promotedDueAt).toEqual(new Date('2026-08-01'));
  });

  it('propagates a transient owner-resolve DB error → rejects, recap NOT published/stamped', async () => {
    setupFreshRun();
    db.findOwnerUserIdByCompanyId.mockRejectedValue(new Error('db down'));

    await expect(runTranscriptPipeline(job, { llm: fakeLlm })).rejects.toMatchObject({
      name: 'TranscriptStageError',
      stage: 'publish_recap',
    });

    // A blip must not silently drop the client's recap: no publish, no stamp (reprocessable).
    expect(publish).not.toHaveBeenCalled();
    expect(db.markRecapPublished).not.toHaveBeenCalled();
  });

  it('drops a money summary headline + emits summary_headline_suppressed (observable)', async () => {
    setupFreshRun();
    const moneyLlm: LlmClient = {
      ...fakeLlm,
      summarize: vi.fn().mockResolvedValue({
        summary: 'We agreed the AUD rate of $200/hr and next steps',
        audit: makeAudit('transcript.summary'),
      }),
    };

    await runTranscriptPipeline(job, { llm: moneyLlm });

    expect(publish).toHaveBeenCalledWith(
      'recap.ready',
      expect.objectContaining({ summaryHeadline: undefined })
    );
    // Suppression is measurable (so false positives can be tuned).
    expect(trackServer).toHaveBeenCalledWith('summary_headline_suppressed', {
      engagement_id: 'eng1',
      meeting_id: null,
      distinct_id: 'system:transcript-pipeline',
    });
  });

  it('does NOT suppress ordinary consulting language (narrowed money vocabulary)', async () => {
    setupFreshRun();
    const cleanLlm: LlmClient = {
      ...fakeLlm,
      summarize: vi.fn().mockResolvedValue({
        summary: 'We reviewed the rate of adoption and a quote from the vendor doc',
        audit: makeAudit('transcript.summary'),
      }),
    };

    await runTranscriptPipeline(job, { llm: cleanLlm });

    // 'rate' / 'quote' are no longer in the vocabulary → the headline survives, no event.
    expect(publish).toHaveBeenCalledWith(
      'recap.ready',
      expect.objectContaining({
        summaryHeadline: 'We reviewed the rate of adoption and a quote from the vendor doc',
      })
    );
    expect(trackServer).not.toHaveBeenCalledWith('summary_headline_suppressed', expect.anything());
  });

  it('emits no suppression event for an empty (Noop) summary', async () => {
    setupFreshRun();
    const noopLlm: LlmClient = {
      ...fakeLlm,
      summarize: vi.fn().mockResolvedValue({ summary: '', audit: makeAudit('transcript.summary') }),
    };

    await runTranscriptPipeline(job, { llm: noopLlm });

    expect(publish).toHaveBeenCalledWith(
      'recap.ready',
      expect.objectContaining({ summaryHeadline: undefined })
    );
    expect(trackServer).not.toHaveBeenCalledWith('summary_headline_suppressed', expect.anything());
  });
});
