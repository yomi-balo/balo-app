import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, generateObject } from 'ai';
import { createLogger } from '@balo/shared/logging';
import type { CanonicalTranscript } from '@balo/db';
import type { ExtractedActionItem, LlmAudit, LlmClient } from './types.js';
import {
  cleanupPrompt,
  summaryPrompt,
  extractionPrompt,
  extractionOutputSchema,
  renderTranscriptText,
} from './prompts.js';
import { TRANSCRIPT_LLM_PROVIDER, resolveCleanupModel, resolveSummaryModel } from './config.js';

const log = createLogger('transcript-llm');

/**
 * Non-streaming output cap for these short text transforms. Kept ≤ the SDK's non-streaming
 * timeout envelope; a long capture that would exceed it is a future streaming-tuning concern
 * (no live capture producer exists yet).
 */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Dedicated, larger cap for cleanup ONLY: cleanup must reproduce the ENTIRE transcript verbatim,
 * so a long consultation exceeds the summary/extraction cap. Summary + extraction stay bounded on
 * `MAX_OUTPUT_TOKENS`. If cleanup still hits this cap we throw (below) rather than persist a
 * silently-truncated half-transcript as the canonical cleaned artifact.
 */
const CLEANUP_MAX_OUTPUT_TOKENS = 32000;

/**
 * Thrown when an LLM text stage hits its output-token cap (`finishReason === 'length'`). This is a
 * DETERMINISTIC failure — a retry re-spends a full Sonnet pass for the same truncated result — so
 * the job layer maps it to BullMQ's `UnrecoverableError` to fail fast (no retry storm). Defined
 * here WITHOUT importing bullmq, to keep the LLM module free of the queue dependency (layering).
 */
export class LlmOutputTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmOutputTruncatedError';
  }
}

/** Warn ONCE across the process when running without a key (avoids per-run log spam). */
let noopWarned = false;

/** Keep the LLM-supplied ISO `dueAt` as a string when it parses to a real date; `null` otherwise. */
function normalizeIsoDueAt(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/**
 * The absent-key path: warns once, then passes the raw transcript through as the "cleaned"
 * text, an empty summary, and zero action items — so the pipeline still completes end-to-end
 * (recap fires, degraded) and dev + CI stay green without an `ANTHROPIC_API_KEY`.
 */
class NoopLlmClient implements LlmClient {
  constructor() {
    if (!noopWarned) {
      noopWarned = true;
      log.warn('ANTHROPIC_API_KEY not set — using the Noop LLM client (passthrough, no summary)');
    }
  }

  private audit(promptId: string, prompt: string): LlmAudit {
    return {
      provider: TRANSCRIPT_LLM_PROVIDER,
      modelId: 'noop',
      modelVersion: null,
      promptId,
      promptVersion: 'v1',
      prompt,
    };
  }

  async cleanupTranscript(input: {
    transcript: CanonicalTranscript;
  }): Promise<{ text: string; audit: LlmAudit }> {
    const p = cleanupPrompt(input.transcript);
    return { text: renderTranscriptText(input.transcript), audit: this.audit(p.promptId, p.user) };
  }

  async summarize(input: { cleanedText: string }): Promise<{ summary: string; audit: LlmAudit }> {
    const p = summaryPrompt(input.cleanedText);
    return { summary: '', audit: this.audit(p.promptId, p.user) };
  }

  async extractActionItems(input: {
    cleanedText: string;
    summary: string;
  }): Promise<{ items: ExtractedActionItem[]; audit: LlmAudit }> {
    const p = extractionPrompt(input);
    return { items: [], audit: this.audit(p.promptId, p.user) };
  }
}

/**
 * The real client, backed by the Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) per ADR-1013's
 * provider-agnostic mandate. `generateText` drives cleanup + summary; `generateObject` drives
 * schema-constrained extraction. A provider swap edits only this class. No `temperature` /
 * thinking budget is passed (rejected on the Sonnet-5 tier and unnecessary for these tasks).
 */
class AnthropicLlmClient implements LlmClient {
  private readonly anthropic: ReturnType<typeof createAnthropic>;

  constructor(apiKey: string) {
    this.anthropic = createAnthropic({ apiKey });
  }

  async cleanupTranscript(input: {
    transcript: CanonicalTranscript;
  }): Promise<{ text: string; audit: LlmAudit }> {
    const modelId = resolveCleanupModel();
    const p = cleanupPrompt(input.transcript);
    const result = await generateText({
      model: this.anthropic(modelId),
      system: p.system,
      prompt: p.user,
      maxOutputTokens: CLEANUP_MAX_OUTPUT_TOKENS,
    });
    if (result.finishReason === 'length') {
      throw new LlmOutputTruncatedError(
        `Transcript cleanup output was truncated at the ${CLEANUP_MAX_OUTPUT_TOKENS}-token cap ` +
          '(finishReason=length) — refusing to persist a partial artifact'
      );
    }
    return {
      text: result.text,
      audit: {
        provider: TRANSCRIPT_LLM_PROVIDER,
        modelId,
        modelVersion: result.response.modelId,
        promptId: p.promptId,
        promptVersion: p.promptVersion,
        prompt: p.user,
      },
    };
  }

  async summarize(input: { cleanedText: string }): Promise<{ summary: string; audit: LlmAudit }> {
    const modelId = resolveSummaryModel();
    const p = summaryPrompt(input.cleanedText);
    const result = await generateText({
      model: this.anthropic(modelId),
      system: p.system,
      prompt: p.user,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    if (result.finishReason === 'length') {
      throw new LlmOutputTruncatedError(
        `Transcript summary output was truncated at the ${MAX_OUTPUT_TOKENS}-token cap ` +
          '(finishReason=length) — refusing to persist a partial artifact'
      );
    }
    return {
      summary: result.text,
      audit: {
        provider: TRANSCRIPT_LLM_PROVIDER,
        modelId,
        modelVersion: result.response.modelId,
        promptId: p.promptId,
        promptVersion: p.promptVersion,
        prompt: p.user,
      },
    };
  }

  async extractActionItems(input: {
    cleanedText: string;
    summary: string;
  }): Promise<{ items: ExtractedActionItem[]; audit: LlmAudit }> {
    const modelId = resolveSummaryModel();
    const p = extractionPrompt(input);
    const result = await generateObject({
      model: this.anthropic(modelId),
      schema: extractionOutputSchema,
      system: p.system,
      prompt: p.user,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const items: ExtractedActionItem[] = result.object.items.map((item) => ({
      body: item.body,
      assigneeParty: item.assigneeParty,
      dueAt: normalizeIsoDueAt(item.dueAt),
    }));
    return {
      items,
      audit: {
        provider: TRANSCRIPT_LLM_PROVIDER,
        modelId,
        modelVersion: result.response.modelId,
        promptId: p.promptId,
        promptVersion: p.promptVersion,
        prompt: p.user,
      },
    };
  }
}

/**
 * Build the injectable LLM client: the real Vercel-AI-SDK client when `ANTHROPIC_API_KEY` is
 * present, else the warn-once passthrough `NoopLlmClient`. Called once per pipeline run (the
 * result is injected into `runTranscriptPipeline`'s deps).
 */
export function createLlmClient(): LlmClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      // In prod the passthrough Noop would silently persist an empty summary + zero action
      // items and stamp the recap as published (unreprocessable). Fail loudly so the job
      // retries and markFailed engages, instead of shipping a degraded recap.
      throw new Error('ANTHROPIC_API_KEY is required in production for the transcript pipeline');
    }
    return new NoopLlmClient();
  }
  return new AnthropicLlmClient(apiKey);
}
