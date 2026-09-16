import type { CanonicalTranscript } from '@balo/db';
import { createAiClient, type AiClient } from '../../ai/index.js';
import type { ExtractedActionItem, LlmAudit, LlmClient, SpeakerPartyHint } from './types.js';
import {
  cleanupPrompt,
  summaryPrompt,
  extractionPrompt,
  extractionOutputSchema,
  renderTranscriptText,
} from './prompts.js';
import { resolveCleanupModel, resolveSummaryModel } from './config.js';

/**
 * Non-streaming output cap for these short text transforms. Kept ≤ the SDK's non-streaming
 * timeout envelope; a long capture that would exceed it is a future streaming-tuning concern
 * (no live capture producer exists yet).
 */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Dedicated, larger cap for cleanup ONLY: cleanup must reproduce the ENTIRE transcript verbatim,
 * so a long consultation exceeds the summary/extraction cap. Summary + extraction stay bounded on
 * `MAX_OUTPUT_TOKENS`. If cleanup still hits this cap the shared seam throws (below) rather than
 * persist a silently-truncated half-transcript as the canonical cleaned artifact.
 */
const CLEANUP_MAX_OUTPUT_TOKENS = 32000;

/**
 * BAL-254 (ADR-1022 amendment) — re-exported from the shared seam so the import path
 * `../services/transcript/llm/anthropic-client.js` keeps working for existing callers
 * (`jobs/transcript-pipeline.ts`).
 */
export { LlmOutputTruncatedError } from '../../ai/index.js';

/** Keep the LLM-supplied ISO `dueAt` as a string when it parses to a real date; `null` otherwise. */
function normalizeIsoDueAt(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/**
 * The transcript pipeline's `LlmClient`, now a THIN domain class over the shared, generic
 * `AiClient` (ADR-1022 amendment). Each stage supplies its own prompt, schema (where relevant)
 * and `noopFallback` — the three fallbacks below are BYTE-IDENTICAL to what the old
 * `NoopLlmClient` hardcoded, so the Noop path's behaviour is unchanged by construction.
 */
class TranscriptLlmClient implements LlmClient {
  constructor(private readonly ai: AiClient) {}

  async cleanupTranscript(input: {
    transcript: CanonicalTranscript;
  }): Promise<{ text: string; audit: LlmAudit }> {
    const p = cleanupPrompt(input.transcript);
    const result = await this.ai.generateText({
      modelId: resolveCleanupModel(),
      system: p.system,
      prompt: p.user,
      maxOutputTokens: CLEANUP_MAX_OUTPUT_TOKENS,
      promptId: p.promptId,
      promptVersion: p.promptVersion,
      noopFallback: () => renderTranscriptText(input.transcript),
    });
    return { text: result.value, audit: result.audit };
  }

  async summarize(input: {
    cleanedText: string;
    partyHint: SpeakerPartyHint | null;
  }): Promise<{ summary: string; audit: LlmAudit }> {
    const p = summaryPrompt(input);
    const result = await this.ai.generateText({
      modelId: resolveSummaryModel(),
      system: p.system,
      prompt: p.user,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      promptId: p.promptId,
      promptVersion: p.promptVersion,
      noopFallback: () => '',
    });
    return { summary: result.value, audit: result.audit };
  }

  async extractActionItems(input: {
    cleanedText: string;
    summary: string;
    partyHint: SpeakerPartyHint | null;
  }): Promise<{ items: ExtractedActionItem[]; audit: LlmAudit }> {
    const p = extractionPrompt(input);
    const result = await this.ai.generateObject({
      modelId: resolveSummaryModel(),
      schema: extractionOutputSchema,
      system: p.system,
      prompt: p.user,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      promptId: p.promptId,
      promptVersion: p.promptVersion,
      noopFallback: () => ({ items: [] }),
    });
    const items: ExtractedActionItem[] = result.value.items.map((item) => ({
      body: item.body,
      assigneeParty: item.assigneeParty,
      dueAt: normalizeIsoDueAt(item.dueAt),
    }));
    return { items, audit: result.audit };
  }
}

/**
 * Build the injectable LLM client, backed by the shared AI seam's absent-key/production-throw
 * posture. `productionRequirementLabel: 'the transcript pipeline'` reproduces the existing prod
 * throw message verbatim (`anthropic-client.test.ts` matches
 * `/ANTHROPIC_API_KEY is required in production/`).
 */
export function createLlmClient(): LlmClient {
  return new TranscriptLlmClient(
    createAiClient({ productionRequirementLabel: 'the transcript pipeline' })
  );
}
