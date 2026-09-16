import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateText, generateObject } from 'ai';
import { createLlmClient, LlmOutputTruncatedError } from './anthropic-client.js';
import { summaryPrompt } from './prompts.js';
import type { SpeakerPartyHint } from './types.js';
import { dailyMultiSpeaker } from '../normalizers/__fixtures__/daily-deepgram.js';
import { normalizeDailyDeepgram } from '../normalizers/daily-deepgram.js';
import { diarizedRef } from '../party-hint/__fixtures__/scenarios.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock the Vercel AI SDK so the present-key path never hits the live API.
vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ modelId })),
}));

const canonical = normalizeDailyDeepgram(dailyMultiSpeaker);

/** Shared by the two BAL-517 hint-wiring tests below (SonarCloud new-code duplication). */
const ROSTER_ONLY_HINT: SpeakerPartyHint = {
  basis: 'roster_only',
  speakers: [
    { ref: diarizedRef('speaker-0'), talkTimePercent: 40 },
    { ref: diarizedRef('speaker-1'), talkTimePercent: 60 },
  ],
};

describe('createLlmClient', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TRANSCRIPT_CLEANUP_MODEL;
    delete process.env.TRANSCRIPT_SUMMARY_MODEL;
  });

  afterEach(() => {
    // Restore NODE_ENV so the prod-throw test never leaks into the other Noop-path tests.
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('warns once when ANTHROPIC_API_KEY is absent (Noop path, no network)', async () => {
    createLlmClient();
    createLlmClient();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
  });

  it('Noop passes the raw transcript through, empty summary, zero action items', async () => {
    const client = createLlmClient();

    const cleaned = await client.cleanupTranscript({ transcript: canonical });
    expect(cleaned.text).toContain('Hi, thanks for jumping on.');
    expect(cleaned.audit.modelId).toBe('noop');
    expect(cleaned.audit.prompt.length).toBeGreaterThan(0); // audit prompt still persisted

    const summarized = await client.summarize({ cleanedText: cleaned.text, partyHint: null });
    expect(summarized.summary).toBe('');

    const extracted = await client.extractActionItems({
      cleanedText: cleaned.text,
      summary: '',
      partyHint: null,
    });
    expect(extracted.items).toEqual([]);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('present key → real client assembles prompt + audit via the AI SDK (mocked)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateText).mockResolvedValue({
      text: 'MODEL_OUTPUT',
      response: { modelId: 'claude-sonnet-5' },
    } as never);
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        items: [{ body: 'Send the migration plan', assigneeParty: 'expert', dueAt: '2026-08-01' }],
      },
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createLlmClient();

    const cleaned = await client.cleanupTranscript({ transcript: canonical });
    expect(cleaned.text).toBe('MODEL_OUTPUT');
    expect(cleaned.audit).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      modelVersion: 'claude-sonnet-5',
      promptId: 'transcript.cleanup',
      promptVersion: 'v2',
    });
    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('clean up'),
        prompt: expect.stringContaining('Hi, thanks for jumping on.'),
        maxOutputTokens: expect.any(Number),
      })
    );

    const summarized = await client.summarize({ cleanedText: 'CLEANED', partyHint: null });
    expect(summarized.summary).toBe('MODEL_OUTPUT');
    expect(summarized.audit.promptId).toBe('transcript.summary');

    const extracted = await client.extractActionItems({
      cleanedText: 'CLEANED',
      summary: 'S',
      partyHint: null,
    });
    expect(extracted.items).toHaveLength(1);
    expect(extracted.items[0]).toMatchObject({
      body: 'Send the migration plan',
      assigneeParty: 'expert',
    });
    expect(extracted.items[0]?.dueAt).toBe('2026-08-01');
    expect(extracted.audit.promptId).toBe('transcript.extract');
    expect(vi.mocked(generateObject)).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: expect.anything(),
        system: expect.stringContaining('action item'),
      })
    );
  });

  it('present key → invalid/absent dueAt coerces to null', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        items: [
          { body: 'A', assigneeParty: null, dueAt: null },
          { body: 'B', assigneeParty: 'client', dueAt: 'not-a-date' },
        ],
      },
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createLlmClient();
    const extracted = await client.extractActionItems({
      cleanedText: 'C',
      summary: 'S',
      partyHint: null,
    });
    expect(extracted.items[0]?.dueAt).toBeNull();
    expect(extracted.items[1]?.dueAt).toBeNull();
  });

  it('cleanup REJECTS when the model output is truncated at the token cap (finishReason=length)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateText).mockResolvedValue({
      text: 'PARTIAL',
      finishReason: 'length',
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createLlmClient();
    await expect(client.cleanupTranscript({ transcript: canonical })).rejects.toThrow(
      LlmOutputTruncatedError
    );
  });

  it('summary REJECTS when the model output is truncated at the token cap (finishReason=length)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateText).mockResolvedValue({
      text: 'PARTIAL',
      finishReason: 'length',
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createLlmClient();
    await expect(client.summarize({ cleanedText: 'CLEANED', partyHint: null })).rejects.toThrow(
      LlmOutputTruncatedError
    );
  });

  it('throws (not Noop) when ANTHROPIC_API_KEY is absent in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createLlmClient()).toThrow(/ANTHROPIC_API_KEY is required in production/);
  });

  // BAL-254 (Ruling D) — added, not modified: extraction now rejects on truncation too.
  it('extraction REJECTS when the structured output is truncated (finishReason=length)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateObject).mockResolvedValue({
      object: { items: [] },
      finishReason: 'length',
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createLlmClient();
    await expect(
      client.extractActionItems({ cleanedText: 'CLEANED', summary: 'S', partyHint: null })
    ).rejects.toThrow(LlmOutputTruncatedError);
  });

  // BAL-254 — added, not modified: proves the transcript path is the TEXT-ONLY branch of the
  // shared seam's generateObject (never the multimodal `messages` branch).
  it('extraction calls generateObject WITHOUT `messages` (text-only branch, unchanged)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateObject).mockResolvedValue({
      object: { items: [] },
      finishReason: 'stop',
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createLlmClient();
    await client.extractActionItems({ cleanedText: 'CLEANED', summary: 'S', partyHint: null });

    const call = vi.mocked(generateObject).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('messages');
    expect(call.prompt).toEqual(expect.stringContaining('CLEANED'));
  });

  // BAL-517 — a hint reaches BOTH summary + extraction, and is retained in the summary audit,
  // so an operator's post-deploy measurement query can rely on the tag surviving in
  // `audit.prompt`.
  it('present key → a hint reaches summary + extraction prompts and the summary audit', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateText).mockResolvedValue({
      text: 'SUMMARY_OUTPUT',
      response: { modelId: 'claude-sonnet-5' },
    } as never);
    vi.mocked(generateObject).mockResolvedValue({
      object: { items: [] },
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createLlmClient();
    const summarized = await client.summarize({
      cleanedText: 'CLEANED',
      partyHint: ROSTER_ONLY_HINT,
    });
    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('speaker_party_hint'),
        prompt: expect.stringContaining('<speaker_party_hint>'),
      })
    );
    expect(summarized.audit.prompt).toContain('<speaker_party_hint>');
    // A post-deploy measurement query reads `left(prompt, strpos(prompt, '<transcript>'))`,
    // which only works because the persisted `audit.prompt` is the USER prompt alone, never
    // system + user. Pin that exactly, not just the substring: the system prompt's
    // `UNTRUSTED_CONTENT_CLAUSE` ALSO contains a literal `<transcript>` (before the hint
    // clause), so if the audit prompt ever became system + user, every hinted transcript would
    // silently mis-classify.
    expect(summarized.audit.prompt).toBe(
      summaryPrompt({ cleanedText: 'CLEANED', partyHint: ROSTER_ONLY_HINT }).user
    );

    await client.extractActionItems({
      cleanedText: 'CLEANED',
      summary: 'S',
      partyHint: ROSTER_ONLY_HINT,
    });
    expect(vi.mocked(generateObject)).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('<speaker_party_hint>'),
      })
    );
  });

  // Cleanup never receives the hint, and its model call never carries the tag, even
  // immediately after a hinted summarize on the same client.
  it("cleanup's model call never carries the hint", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateText).mockResolvedValue({
      text: 'OUTPUT',
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createLlmClient();
    await client.summarize({ cleanedText: 'CLEANED', partyHint: ROSTER_ONLY_HINT });
    await client.cleanupTranscript({ transcript: canonical });

    const cleanupCall = vi.mocked(generateText).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(cleanupCall.system).not.toContain('speaker_party_hint');
    expect(cleanupCall.prompt).not.toContain('speaker_party_hint');
  });
});
