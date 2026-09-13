import type { CanonicalTranscript, ExtractedActionItem } from '@balo/db';
import type { LlmAudit } from '../../ai/index.js';

// Single source of truth for the extraction item shape — re-export `@balo/db`'s
// `ExtractedActionItem` (the jsonb `$type` owner) rather than redefine it here, so the
// pipeline, the repository seam, and the LLM client never drift (and SonarCloud sees no dup).
export type { ExtractedActionItem } from '@balo/db';

/**
 * BAL-254 (ADR-1022 amendment) — MOVED to the shared AI seam (`services/ai/types.ts`). Re-exported
 * here, byte-identical shape, so every downstream import (`pipeline.ts`, `transcript_artifacts`
 * mapping) is untouched. Provenance persisted per LLM-derived artifact (ADR-1013: "store cleanup
 * model id + version + prompt" so cleaned-vs-raw stays auditable).
 */
export type { LlmAudit };

/**
 * The swappable, INJECTABLE LLM seam (ADR-1013 mandates a provider-agnostic layer). The
 * pipeline takes a `LlmClient` in its deps, so unit tests inject a deterministic fake and
 * never hit the live API. The real implementation (`createLlmClient`) is backed by the Vercel
 * AI SDK; a provider swap edits that one module.
 */
export interface LlmClient {
  cleanupTranscript(input: {
    transcript: CanonicalTranscript;
  }): Promise<{ text: string; audit: LlmAudit }>;
  summarize(input: { cleanedText: string }): Promise<{ summary: string; audit: LlmAudit }>;
  extractActionItems(input: {
    cleanedText: string;
    summary: string;
  }): Promise<{ items: ExtractedActionItem[]; audit: LlmAudit }>;
}
