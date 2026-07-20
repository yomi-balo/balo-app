/**
 * BAL-387 (ADR-1013) — transcript LLM model config. `claude-sonnet-5` is the
 * cost-appropriate high-volume tier for these text-transform stages (exact model id, no date
 * suffix; `claude-opus-4-8` is a documented upgrade option for the summary stage). Read at the
 * point of use so a deployed env override takes effect without a rebuild.
 */

export const TRANSCRIPT_LLM_PROVIDER = 'anthropic' as const;

/** Default model for every transcript stage (cleanup / summary / extraction). */
export const DEFAULT_TRANSCRIPT_MODEL = 'claude-sonnet-5';

/** Resolve the cleanup model — `TRANSCRIPT_CLEANUP_MODEL` env override → default. */
export function resolveCleanupModel(): string {
  return process.env.TRANSCRIPT_CLEANUP_MODEL ?? DEFAULT_TRANSCRIPT_MODEL;
}

/** Resolve the summary + extraction model — `TRANSCRIPT_SUMMARY_MODEL` env override → default. */
export function resolveSummaryModel(): string {
  return process.env.TRANSCRIPT_SUMMARY_MODEL ?? DEFAULT_TRANSCRIPT_MODEL;
}
