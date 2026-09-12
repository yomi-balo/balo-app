/**
 * BAL-549 WEB-REVIEW FIX ROUND (W3) — "did this failure mean my page is out of date?".
 *
 * Both decision actions return a discriminated `code` on failure SPECIFICALLY so the UI can
 * react to a lost race, and both callers originally only toasted. `'not_pending'` (someone else
 * decided it first) and `'gone'` (the profile no longer exists) both mean the SERVER's truth has
 * moved on while this page was open — the staffer who lost the race keeps looking at live
 * Approve / Decline controls until a manual reload, and their next click fails the same way.
 * A `router.refresh()` re-renders the segment into its decided state, which is exactly what the
 * codes were added for.
 *
 * ⚠ `'denied'` DOES NOT REFRESH. That code means the actor lacks `REVIEW_EXPERT_APPLICATIONS`,
 * which a re-render cannot change: the page data is not stale, so refreshing would cost a round
 * trip, flash the surface, and still show the same controls. Capability changes arrive with a new
 * session, not with a refresh.
 *
 * ⚠ NOR DOES A CODELESS FAILURE (validation, or the generic catch): those say nothing about
 * whether the page is current.
 *
 * ⚠ CLIENT-SAFE, and the home of the code union. `_actions/_shared/decision-outcome.ts` carries
 * `import 'server-only'`, so neither `'use client'` caller can import a runtime value from it —
 * the union lives here and the server module imports it back, keeping ONE definition.
 */

/** The `code` discriminants the two decision actions may return on failure. */
export type DecisionFailureCode = 'not_pending' | 'gone' | 'denied';

/** True when a failed decision means this page is showing stale state. */
export function decisionOutcomeIsStale(code: DecisionFailureCode | undefined): boolean {
  return code === 'not_pending' || code === 'gone';
}
