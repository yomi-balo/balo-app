import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngagementNotActiveError } from '@balo/db';
import {
  runTranscriptPipeline,
  resumeTranscriptRecap,
  type TranscriptPipelineJobInput,
} from './pipeline.js';
import type { LlmAudit, LlmClient } from './llm/types.js';
import { dailyMultiSpeaker } from './normalizers/__fixtures__/daily-deepgram.js';
import { normalizeVendorPayload } from './normalizers/index.js';
import type { CanonicalTranscript } from '@balo/db';
import { renderTranscriptText, summaryPrompt } from './llm/prompts.js';
import {
  MEETING_ID as PARTY_HINT_MEETING_ID,
  EXPERT_USER_ID,
  CLIENT_USER_ID,
  EXPERT_WAITING_TURNS,
  EXPERT_WAITING_HINT,
  diarizedCanonical,
  expertWaitingPayload,
  presenceRow,
  recordingSegment,
} from './party-hint/__fixtures__/scenarios.js';

// ── Hoisted mock fns ───────────────────────────────────────────────────────────
const db = vi.hoisted(() => ({
  findByCaptureId: vi.fn(),
  // BAL-550 — the resume entry's read. ADDED, not a change to any existing arm: no existing
  // test names `findById`, so this is pure additive surface.
  findById: vi.fn(),
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
  // BAL-517 — the party-hint resolver's reads, real `resolvePartyHint` + real `derivePartyHint`.
  findByTranscriptJobId: vi.fn(),
  listByMeeting: vi.fn(),
}));
const publish = vi.hoisted(() => vi.fn());
const trackServer = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('@balo/db', () => {
  class EngagementNotActiveError extends Error {}
  return {
    transcriptsRepository: {
      findByCaptureId: db.findByCaptureId,
      findById: db.findById,
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
    meetingRecordingsRepository: { findByTranscriptJobId: db.findByTranscriptJobId },
    meetingPresenceRepository: { listByMeeting: db.listByMeeting },
    EngagementNotActiveError,
  };
});

// BAL-550 — spies on the REAL implementation (never replaces it), so every existing test's
// behaviour is byte-identical; only `resumeTranscriptRecap`'s tests assert on call count.
vi.mock('./normalizers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./normalizers/index.js')>();
  return { ...actual, normalizeVendorPayload: vi.fn(actual.normalizeVendorPayload) };
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
  createLogger: () => logger,
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────
const makeAudit = (promptId: string): LlmAudit => ({
  provider: 'anthropic',
  modelId: 'noop',
  modelVersion: null,
  promptId,
  promptVersion: 'v2',
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

/** BAL-418: `transcripts.meeting_id` is a NOT NULL FK → `meetings.id`, so this is never null. */
const MEETING_ID = '11111111-1111-4111-8111-111111111111';

function makeTranscript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tr1',
    engagementId: 'eng1',
    meetingId: MEETING_ID,
    vendor: 'daily_deepgram',
    extractedActionItems: null,
    actionItemsExtractedAt: null,
    recapReadyPublishedAt: null,
    ...overrides,
  };
}

const job: TranscriptPipelineJobInput = {
  captureId: 'cap1',
  engagementId: 'eng1',
  meetingId: MEETING_ID,
  vendor: 'daily_deepgram',
  payload: dailyMultiSpeaker,
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
  // BAL-517 — the party-hint resolver's reads. Defaulted so every EXISTING test (whose
  // canonical is the AUTHENTICATED `dailyMultiSpeaker` fixture) short-circuits on the pure
  // precheck and never reaches either mock; asserted explicitly below.
  db.findByTranscriptJobId.mockResolvedValue(undefined);
  db.listByMeeting.mockResolvedValue([]);
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
    // BAL-517 — the job's canonical (`dailyMultiSpeaker`) is the AUTHENTICATED arm, so the
    // pure precheck gates it out with NO DB read at all: partyHint is null, and both prompts
    // decide explicitly (never omitted).
    expect(fakeLlm.summarize).toHaveBeenCalledWith({ cleanedText: 'CLEANED', partyHint: null });
    expect(fakeLlm.extractActionItems).toHaveBeenCalledWith({
      cleanedText: 'CLEANED',
      summary: 'Recap headline\ndetails',
      partyHint: null,
    });
    expect(db.findByTranscriptJobId).not.toHaveBeenCalled();
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
      meeting_id: MEETING_ID,
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

// ── BAL-550 (D5) — the resume entry ─────────────────────────────────────────────
const CANONICAL = {
  schemaVersion: 1,
  vendor: 'daily_deepgram',
  language: 'en',
  fillerWords: false,
  speakers: [],
  segments: [],
  durationMs: 12500,
};

function makeResumedTranscript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...makeTranscript(),
    captureId: 'cap1',
    canonical: CANONICAL,
    ...overrides,
  };
}

describe('resumeTranscriptRecap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a missing/soft-deleted transcript is a logged no-op, never a throw', async () => {
    db.findById.mockResolvedValue(undefined);

    await expect(
      resumeTranscriptRecap({ transcriptId: 'tr-gone', auditEventId: 'audit1' }, { llm: fakeLlm })
    ).resolves.toBeUndefined();

    expect(fakeLlm.cleanupTranscript).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('never calls normalizeVendorPayload — the row is the input, not a vendor payload', async () => {
    setupFreshRun();
    const resumed = makeResumedTranscript();
    db.findById.mockResolvedValue(resumed as never);
    db.findByTranscriptAndKind.mockResolvedValue(undefined);

    await resumeTranscriptRecap({ transcriptId: 'tr1', auditEventId: 'audit1' }, { llm: fakeLlm });

    expect(normalizeVendorPayload).not.toHaveBeenCalled();
    expect(db.insertRaw).not.toHaveBeenCalled();
  });

  it('a row whose cleaned + summary artifacts exist never calls the LLM and publishes once', async () => {
    setupFreshRun();
    const resumed = makeResumedTranscript({
      extractedActionItems: [{ body: 'Do X', assigneeParty: 'client', dueAt: null }],
    });
    db.findById.mockResolvedValue(resumed as never);
    db.findByTranscriptAndKind.mockResolvedValue({ content: 'existing' } as never);

    await resumeTranscriptRecap({ transcriptId: 'tr1', auditEventId: 'audit1' }, { llm: fakeLlm });

    expect(fakeLlm.cleanupTranscript).not.toHaveBeenCalled();
    expect(fakeLlm.summarize).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(db.markRecapPublished).toHaveBeenCalledWith('tr1');
  });

  it('a row with recap_ready_published_at set publishes nothing further', async () => {
    setupFreshRun();
    const resumed = makeResumedTranscript({
      extractedActionItems: [{ body: 'Do X', assigneeParty: 'client', dueAt: null }],
      actionItemsExtractedAt: new Date(),
      recapReadyPublishedAt: new Date(),
    });
    db.findById.mockResolvedValue(resumed as never);
    db.findByTranscriptAndKind.mockResolvedValue({ content: 'existing' } as never);

    await resumeTranscriptRecap({ transcriptId: 'tr1', auditEventId: 'audit1' }, { llm: fakeLlm });

    expect(publish).not.toHaveBeenCalled();
    expect(db.markRecapPublished).not.toHaveBeenCalled();
  });

  it('a row with action_items_extracted_at set never calls createFromExtraction', async () => {
    setupFreshRun();
    const resumed = makeResumedTranscript({
      extractedActionItems: [{ body: 'Do X', assigneeParty: 'client', dueAt: null }],
      actionItemsExtractedAt: new Date(),
    });
    db.findById.mockResolvedValue(resumed as never);
    db.findByTranscriptAndKind.mockResolvedValue({ content: 'existing' } as never);

    await resumeTranscriptRecap({ transcriptId: 'tr1', auditEventId: 'audit1' }, { llm: fakeLlm });

    expect(db.createFromExtraction).not.toHaveBeenCalled();
  });

  it('a stage throw surfaces as TranscriptStageError with the right stage', async () => {
    setupFreshRun();
    const resumed = makeResumedTranscript();
    db.findById.mockResolvedValue(resumed as never);
    db.findByTranscriptAndKind.mockResolvedValue(undefined);
    db.upsert.mockRejectedValue(new Error('db down'));

    await expect(
      resumeTranscriptRecap({ transcriptId: 'tr1', auditEventId: 'audit1' }, { llm: fakeLlm })
    ).rejects.toMatchObject({ name: 'TranscriptStageError', stage: 'cleanup' });
  });

  it('a fresh resume (nothing done yet) runs stages 3-6 and publishes', async () => {
    setupFreshRun();
    const resumed = makeResumedTranscript();
    db.findById.mockResolvedValue(resumed as never);
    db.findByTranscriptAndKind.mockResolvedValue(undefined);

    await resumeTranscriptRecap({ transcriptId: 'tr1', auditEventId: 'audit1' }, { llm: fakeLlm });

    expect(fakeLlm.cleanupTranscript).toHaveBeenCalledTimes(1);
    expect(fakeLlm.summarize).toHaveBeenCalledTimes(1);
    expect(db.createFromExtraction).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      'recap.ready',
      expect.objectContaining({ transcriptId: 'tr1' })
    );
  });
});

// ── BAL-517 — party hint wiring, using the REAL resolver + REAL derivation (only the DB mocked) ──
describe('BAL-517 party hint', () => {
  const EXPECTED_HINT = EXPERT_WAITING_HINT;

  const hintJob: TranscriptPipelineJobInput = {
    captureId: 'daily-batch:job-1',
    engagementId: 'eng1',
    meetingId: PARTY_HINT_MEETING_ID,
    vendor: 'daily_deepgram',
    payload: expertWaitingPayload(),
    durationMs: null,
  };

  function makeHintTranscript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'tr-hint',
      engagementId: 'eng1',
      meetingId: PARTY_HINT_MEETING_ID,
      vendor: 'daily_deepgram',
      extractedActionItems: null,
      actionItemsExtractedAt: null,
      recapReadyPublishedAt: null,
      ...overrides,
    };
  }

  // Cleanup returns the exact render (so `cleaned_labels_not_preserved` never trips). Summarize
  // echoes `summaryPrompt(input).user` into `audit.prompt`, exactly as the real
  // `TranscriptLlmClient` does — this is what lets test (e) observe the persisted audit prompt.
  const hintLlm: LlmClient = {
    cleanupTranscript: vi.fn(async (input: { transcript: CanonicalTranscript }) => ({
      text: renderTranscriptText(input.transcript),
      audit: makeAudit('transcript.cleanup'),
    })),
    summarize: vi.fn(async (input: Parameters<LlmClient['summarize']>[0]) => ({
      summary: 'Recap headline\ndetails',
      audit: { ...makeAudit('transcript.summary'), prompt: summaryPrompt(input).user },
    })),
    extractActionItems: vi.fn().mockResolvedValue({
      items: [{ body: 'Do X', assigneeParty: 'client', dueAt: null }],
      audit: makeAudit('transcript.extract'),
    }),
  };

  function mockPresence(): void {
    db.findByTranscriptJobId.mockResolvedValue(
      recordingSegment({ meetingId: PARTY_HINT_MEETING_ID })
    );
    db.listByMeeting.mockResolvedValue([
      presenceRow('expert', { userId: EXPERT_USER_ID }, -60, null),
      presenceRow('client', { userId: CLIENT_USER_ID }, 300, null),
    ]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupFreshRun();
    db.findByCaptureId.mockResolvedValue(undefined);
    db.insertRaw.mockResolvedValue(makeHintTranscript() as never);
    db.findByTranscriptAndKind.mockResolvedValue(undefined);
  });

  it('a) wired: summarize + extraction receive the SAME hint; cleanup never sees it', async () => {
    mockPresence();

    await runTranscriptPipeline(hintJob, { llm: hintLlm });

    expect(hintLlm.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ partyHint: EXPECTED_HINT })
    );
    expect(hintLlm.extractActionItems).toHaveBeenCalledWith(
      expect.objectContaining({ partyHint: EXPECTED_HINT })
    );
    // Exact equality: an extra `partyHint` key on the cleanup call would fail this — cleanup
    // must never see the hint.
    const [cleanupCall] = vi.mocked(hintLlm.cleanupTranscript).mock.calls;
    expect(cleanupCall?.[0]).toEqual({ transcript: expect.anything() });
  });

  it('b) re-drive gets the same hint as the original run', async () => {
    mockPresence();
    const resumedCanonical = diarizedCanonical(EXPERT_WAITING_TURNS);
    db.findById.mockResolvedValue(
      makeHintTranscript({ captureId: 'daily-batch:job-1', canonical: resumedCanonical }) as never
    );

    await resumeTranscriptRecap(
      { transcriptId: 'tr-hint', auditEventId: 'audit1' },
      { llm: hintLlm }
    );

    expect(hintLlm.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ partyHint: EXPECTED_HINT })
    );
  });

  it('c) a lookup failure degrades to no hint, and the recap still publishes', async () => {
    db.findByTranscriptJobId.mockRejectedValue(new Error('db down'));

    await runTranscriptPipeline(hintJob, { llm: hintLlm });

    expect(hintLlm.summarize).toHaveBeenCalledWith(expect.objectContaining({ partyHint: null }));
    expect(publish).toHaveBeenCalledWith('recap.ready', expect.anything());
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptId: 'tr-hint' }),
      'Transcript party hint lookup failed — continuing without a hint'
    );
  });

  it('d) short-circuit: an existing summary artifact means zero repository reads for the hint', async () => {
    db.findByTranscriptAndKind.mockResolvedValue({ content: 'existing' } as never);

    await runTranscriptPipeline(hintJob, { llm: hintLlm });

    expect(db.findByTranscriptJobId).not.toHaveBeenCalled();
    expect(db.listByMeeting).not.toHaveBeenCalled();
  });

  it('e) AC2: canonical carries no inferred identity, and only the summary audit prompt carries the hint', async () => {
    mockPresence();

    await runTranscriptPipeline(hintJob, { llm: hintLlm });

    const [insertRawCall] = db.insertRaw.mock.calls;
    if (insertRawCall === undefined) {
      throw new Error('insertRaw was not called');
    }
    const insertRawArg = insertRawCall[0] as { canonical: CanonicalTranscript };
    for (const speaker of insertRawArg.canonical.speakers) {
      expect(speaker.userId).toBeNull();
      expect(speaker.displayName).toBeNull();
      expect(speaker.source).toBe('diarized');
    }
    expect(insertRawArg.canonical).toEqual(
      structuredClone(diarizedCanonical(EXPERT_WAITING_TURNS))
    );

    const cleanedUpsert = db.upsert.mock.calls.find(
      (call) => (call[0] as { kind: string }).kind === 'cleaned'
    )?.[0];
    const summaryUpsert = db.upsert.mock.calls.find(
      (call) => (call[0] as { kind: string }).kind === 'summary'
    )?.[0] as { content: string; prompt: string } | undefined;

    const mustNotLeak: unknown[] = [
      insertRawArg,
      db.setExtractedActionItems.mock.calls[0],
      db.createFromExtraction.mock.calls[0]?.[0],
      db.markRecapPublished.mock.calls[0],
      publish.mock.calls[0],
      cleanedUpsert,
      summaryUpsert?.content,
    ];
    // A paired existence assertion PLUS a length check: without them, a stage that stopped
    // firing (or was renamed) would leave that entry `undefined`,
    // `JSON.stringify(undefined) ?? ''` would be `''`, and the loop's `not.toContain` checks
    // below would pass vacuously for that entry.
    expect(mustNotLeak).toHaveLength(7);
    for (const value of mustNotLeak) {
      expect(value).toBeDefined();
      const json = JSON.stringify(value) ?? '';
      expect(json).not.toContain('speaker_party_hint');
      expect(json).not.toContain('Tentative reading');
    }

    // The audit IS retained deliberately — the summary artifact's `prompt` column carries the tag.
    expect(summaryUpsert?.prompt).toContain('<speaker_party_hint>');
  });
});
