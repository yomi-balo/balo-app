import type { z } from 'zod';

/**
 * ADR-1022 amendment (BAL-254) — the generic, provider-agnostic AI seam. Extracted from the
 * transcript pipeline's welded-in LLM client (ADR-1013) because BAL-254 is a second consumer
 * needing two things transcript does not: multimodal (PDF + image) input, and a bounded model
 * allow-list guaranteeing a vision-capable model. See the ADR-1022 amendment draft in the plan
 * for the full rationale.
 */

export const AI_PROVIDER = 'anthropic' as const;
export type AiProvider = typeof AI_PROVIDER;

/**
 * MOVED here from `services/transcript/llm/types.ts`. Shape byte-identical — transcript
 * re-exports this type so every downstream import (`pipeline.ts`, `transcript_artifacts`
 * mapping) is untouched.
 */
export interface LlmAudit {
  provider: AiProvider;
  /** Resolved model id, or `'noop'` on the absent-key path. */
  modelId: string;
  modelVersion: string | null;
  promptId: string;
  promptVersion: string;
  /** Exact rendered user prompt. */
  prompt: string;
}

/** Token usage, when the provider reports it. Both `null` on the Noop path. */
export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Media types the multimodal path accepts — the project-document allow-list, verbatim. */
export type AiFileMediaType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';

export interface AiFilePart {
  readonly data: Uint8Array;
  readonly mediaType: AiFileMediaType;
  readonly filename?: string;
}

interface AiRequestBase {
  readonly modelId: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly promptId: string;
  readonly promptVersion: string;
}

export interface GenerateTextRequest extends AiRequestBase {
  /**
   * ⚠ The degraded value returned when no API key is configured (ADR-1022 amendment §1). The
   * Noop client cannot invent a value of an arbitrary result type, so every request supplies
   * its own fallback thunk.
   */
  readonly noopFallback: () => string;
}

export interface GenerateObjectRequest<T> extends AiRequestBase {
  readonly schema: z.ZodType<T>;
  readonly noopFallback: () => T;
  /** Appended to the user message as `FilePart`s. Omit for a text-only call. */
  readonly files?: readonly AiFilePart[];
}

export interface AiResult<T> {
  readonly value: T;
  readonly audit: LlmAudit;
  readonly usage: AiUsage;
}

export interface AiClient {
  generateText(request: GenerateTextRequest): Promise<AiResult<string>>;
  generateObject<T>(request: GenerateObjectRequest<T>): Promise<AiResult<T>>;
}
