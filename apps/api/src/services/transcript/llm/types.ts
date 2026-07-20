import type { CanonicalTranscript, ExtractedActionItem } from '@balo/db';

// Single source of truth for the extraction item shape — re-export `@balo/db`'s
// `ExtractedActionItem` (the jsonb `$type` owner) rather than redefine it here, so the
// pipeline, the repository seam, and the LLM client never drift (and SonarCloud sees no dup).
export type { ExtractedActionItem } from '@balo/db';

/**
 * Provenance persisted per LLM-derived artifact (ADR-1013: "store cleanup model id + version
 * + prompt" so cleaned-vs-raw stays auditable). Mapped 1:1 onto `transcript_artifacts` audit
 * columns by the pipeline.
 */
export interface LlmAudit {
  provider: 'anthropic';
  modelId: string; // e.g. 'claude-sonnet-5' (or 'noop' on the absent-key path)
  modelVersion: string | null; // resolved model/snapshot if surfaced
  promptId: string; // 'transcript.cleanup' | 'transcript.summary' | 'transcript.extract'
  promptVersion: string; // 'v1'
  prompt: string; // exact rendered prompt (persisted to transcript_artifacts.prompt)
}

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
