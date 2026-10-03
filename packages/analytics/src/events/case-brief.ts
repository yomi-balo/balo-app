import type { ProjectBriefFailureReason } from '@balo/shared/project-requests';

/**
 * BAL-589 — the "Convert a case to a project" AI brief's CLIENT event family. A NEW namespace
 * (`case_brief_*`), not folded into `PROJECT_EVENTS`'s `PROJECT_AI_*` family:
 * the case path never fires `PROJECT_AI_GENERATE_*` (`ProjectDraft.source` stays `'manual'`
 * on a case mount, and the AI brief flow there is a different hook, `useCaseBriefFlow`), so a
 * shared event would conflate two funnels with different triggers and different failure
 * vocabularies (`case_unavailable` / `no_case_history` exist only on this path).
 *
 * Both events are browser-emitted by `useCaseBriefFlow` (apps/web); there is no server family.
 *
 * ⚠ NO CASE CONTENT, NO MONEY. `case_id` is the only identifier; `failure_reason` is the closed
 * `ProjectBriefFailureReason` vocabulary, never a message string.
 */
export const CASE_BRIEF_EVENTS = {
  /** The case brief generation reached a terminal phase (success or failure), once per run. */
  GENERATED: 'case_brief_generated',
  /** A redraft actually ran (after any "replace your edits?" confirm). */
  REGENERATED: 'case_brief_regenerated',
} as const;

export interface CaseBriefEventMap {
  [CASE_BRIEF_EVENTS.GENERATED]: {
    case_id: string;
    /** Client wall-clock time from start to terminal phase. */
    latency_ms: number;
    success: boolean;
    failure_reason: ProjectBriefFailureReason | null;
  };
  [CASE_BRIEF_EVENTS.REGENERATED]: {
    case_id: string;
  };
}
