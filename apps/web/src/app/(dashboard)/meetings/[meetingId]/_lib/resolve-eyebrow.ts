import type { RecapContextType } from '@balo/analytics/events';
import { meetingTypeLabel } from '@/lib/meetings/meeting-type-label';

/**
 * BAL-388 §R1 — the EYEBROW. PURE lookup, no I/O.
 *
 * This is what replaces the missing breadcrumb: it tells the reader WHAT KIND of meeting this
 * was before they read the title.
 *
 * ⚠ `admin` IS ABSENT AND MUST STAY ABSENT. `selectPrimaryMeetingContext` drops `admin` rows,
 * so the read gate 404s an admin-only meeting before this is ever reached. A branch no code
 * path can enter is dead coverage — see `resolve-recap-access.ts`.
 *
 * BAL-566 (D5) — delegates to `meetingTypeLabel` (`@/lib/meetings/meeting-type-label`), the ONE
 * shared definition of "what does this context type render as", so the recap and the dashboard
 * Up next card cannot drift. `RecapContextType` is an alias of `MeetingContextTypeWithHolder`,
 * so no cast is needed. The label map moved there VERBATIM, including the MJ note on "Intro
 * call" and the `admin`-is-absent reasoning above.
 */
export function resolveEyebrow(contextType: RecapContextType): string {
  return meetingTypeLabel(contextType);
}

/**
 * Only a `case` carries per-meeting money, an ordinal line and a resolve prompt. Stated ONCE
 * here so the three surfaces cannot drift apart.
 */
export function contextIsCase(contextType: RecapContextType): boolean {
  return contextType === 'case';
}

/**
 * BAL-421 — the recap's back link to its case, or `null` when there is nowhere to go.
 *
 * ⚠ ONLY THE `case` CONTEXT'S `contextId` IS AN `engagements.id`. Every other context yields
 * `null` and NO link renders — never a disabled or dead one. Lives here, beside
 * {@link contextIsCase}, because "what does this context's id actually point at" is exactly
 * the question this module already answers once for all three surfaces.
 *
 * ⚠ NO `?from=recap`, DELIBERATELY. The case→recap direction DOES carry `?from=case_surface`,
 * because `RecapEntrySource` declares that value and `resolveEntrySource` reads it. Nothing
 * reads a `from` param on `/cases/{id}`: `case_surface_viewed` carries lens /
 * consultation_count / case_state and has no `source` dimension. Appending one anyway would
 * be an unread query string that LOOKS like instrumentation. Add it in the change that reads it.
 */
export function resolveCaseHref(isCase: boolean, contextId: string): string | null {
  return isCase ? '/cases/' + contextId : null;
}
