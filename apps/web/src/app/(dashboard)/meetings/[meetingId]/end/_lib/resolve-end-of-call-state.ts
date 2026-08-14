import type { EndOfCallRecapState, RecapContextType } from '@/lib/meetings/end-of-call-view-types';
import type { TranscriptStatusLike } from '../../_lib/resolve-recap-state';

/**
 * BAL-389 — the end-of-call screen's PURE derivations. No I/O, no clock, no `@balo/db`, no
 * React. Everything here is a unit test away from proof, which matters because the states that
 * matter most are the ones production cannot reach yet.
 */

/**
 * Is the recap ready, or still on its way?
 *
 * ⚠⚠ THIS IS DELIBERATELY **NOT** `resolveRecapState`, AND NOBODY SHOULD "UNIFY" THEM LATER.
 * That resolver answers a SIX-way question (`ready | processing | artifacts_absent |
 * artifacts_failed | not_held | cancelled`) and needs TWO `transcript_artifacts` CONTENT reads
 * to do it. This screen has a TWO-way render — the design's `Recap: processing | ready` toggle —
 * and per the owner decision the onward CTA is "View recap" either way, so readiness changes
 * only whether the "Your recap is being prepared." subcopy shows. Reusing the six-way resolver
 * would mean two content reads whose payloads are thrown away, plus four states this screen
 * cannot render — and a dimension value nothing emits reads as a 100%-drop-off funnel step.
 *
 * ⚠ `failed` AND `null` BOTH FOLD INTO `processing`, AND THAT IS HONEST RATHER THAN LOSSY. The
 * recap page renders its OWN failure state; this screen's only job is to decide whether to
 * promise that the recap is coming. Promising it after a failed run is the smaller wrong than
 * dead-ending someone on a throwaway screen — and `null` (no transcript row at all) is the
 * common case today, because BAL-387 shipped the pipeline INERT with no production enqueuer.
 */
export function resolveEndOfCallRecapReadiness(
  transcriptStatus: TranscriptStatusLike | null
): EndOfCallRecapState {
  return transcriptStatus === 'ready' ? 'ready' : 'processing';
}

/**
 * The meeting contexts whose `context_id` names an engagement a review can actually be written
 * against.
 *
 * ⚠⚠ THIS SET IS DECIDED BY THE WRITE PATH, NOT BY TASTE. `applyReview`'s `reviewableKind`
 * accepts `project` and `case` and REFUSES `package` / `retainer`, so:
 *   · `case` and `project_kickoff` are engagement-grain AND reviewable — they qualify;
 *   · `package_session` / `retainer_checkin` are engagement-grain but their engagement types
 *     are declared-and-unbuilt, so a submit would ALWAYS fail. Offering a control that can only
 *     error is worse than not offering it (the same rule the recap applies to its action-items
 *     panel), and neither context has a producer today;
 *   · `project_discovery` and `request_interaction` are REQUEST-grain — their `context_id` is
 *     not an engagement id at all, so there is nothing to anchor a review to.
 */
export const RATEABLE_CONTEXTS: ReadonlySet<RecapContextType> = new Set<RecapContextType>([
  'case',
  'project_kickoff',
]);

/** Can a review be captured for this meeting's context? See {@link RATEABLE_CONTEXTS}. */
export function contextIsRateable(contextType: RecapContextType): boolean {
  return RATEABLE_CONTEXTS.has(contextType);
}
