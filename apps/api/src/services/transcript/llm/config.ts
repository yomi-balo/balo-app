/**
 * BAL-387 (ADR-1013) — transcript LLM model config. `claude-sonnet-5` is the
 * cost-appropriate high-volume tier for these text-transform stages (exact model id, no date
 * suffix; `claude-opus-4-8` is a documented upgrade option for the summary stage). Read at the
 * point of use so a deployed env override takes effect without a rebuild.
 *
 * BAL-254 (Ruling B) — resolution now delegates to the shared `resolveModelId` seam, called with
 * NO `allowList`: permissive resolution, byte-identical to the old `process.env.X ?? DEFAULT`
 * behaviour. The allow-list introduced for the project-brief parser applies to that consumer
 * ONLY — no deployed `TRANSCRIPT_*_MODEL` override may begin failing because of it.
 *
 * ⚠ `TRANSCRIPT_LLM_PROVIDER` USED TO BE RE-EXPORTED HERE AND IS GONE (fix round F18). Once the
 * audit record started carrying `provider` from the shared seam itself, nothing imported it —
 * and a dead re-export is dead code. `AI_PROVIDER` (`services/ai/types.ts`) is the one name for
 * the provider literal; import it from there if a second one is ever genuinely needed.
 */
import { resolveModelId } from '../../ai/index.js';

/** Default model for every transcript stage (cleanup / summary / extraction). */
export const DEFAULT_TRANSCRIPT_MODEL = 'claude-sonnet-5';

/** Resolve the cleanup model — `TRANSCRIPT_CLEANUP_MODEL` env override → default. */
export function resolveCleanupModel(): string {
  return resolveModelId({
    override: process.env.TRANSCRIPT_CLEANUP_MODEL, // ⚠ literal — D8
    defaultModelId: DEFAULT_TRANSCRIPT_MODEL,
    // No allowList — Ruling B.
  });
}

/** Resolve the summary + extraction model — `TRANSCRIPT_SUMMARY_MODEL` env override → default. */
export function resolveSummaryModel(): string {
  return resolveModelId({
    override: process.env.TRANSCRIPT_SUMMARY_MODEL, // ⚠ literal — D8
    defaultModelId: DEFAULT_TRANSCRIPT_MODEL,
    // No allowList — Ruling B.
  });
}
