import type { RecapContextType } from '@balo/analytics/events';

/**
 * BAL-388 §R1 — the EYEBROW. PURE lookup, no I/O.
 *
 * This is what replaces the missing breadcrumb: it tells the reader WHAT KIND of meeting this
 * was before they read the title. There is no `default:` arm that could render an enum value
 * at a user — the record is TOTAL over `RecapContextType`, so a seventh label added to
 * `meeting_context_type` fails `tsc` here rather than shipping a raw `retainer_checkin` to a
 * client.
 *
 * ⚠ `admin` IS ABSENT AND MUST STAY ABSENT. `selectPrimaryMeetingContext` drops `admin` rows,
 * so the read gate 404s an admin-only meeting before this is ever reached. A branch no code
 * path can enter is dead coverage — see `resolve-recap-access.ts`.
 *
 * ⚠ STORED IN SENTENCE CASE; THE `uppercase` IS CSS. Repo precedent, and assistive tech
 * spells short all-caps strings out letter by letter.
 *
 * ⚠ `request_interaction` RENDERS, as an intro call (owner decision D-D), consistent with
 * BAL-423's meeting-file gate already treating request-grain contexts as first-class. The
 * RENDERING RULING STANDS REGARDLESS OF THE FINAL LABEL — the wording below is on the MJ copy
 * list and may change without reopening the decision.
 */
const EYEBROW_BY_CONTEXT: Record<RecapContextType, string> = {
  case: 'Consultation',
  project_discovery: 'Discovery call',
  project_kickoff: 'Project kickoff',
  package_session: 'Package session',
  retainer_checkin: 'Retainer check-in',
  // ⚠ MJ COPY CHECKPOINT (D-D, sixth flagged item) — wording only, not the ruling.
  request_interaction: 'Intro call',
};

/** The eyebrow label for a primary context type. */
export function resolveEyebrow(contextType: RecapContextType): string {
  return EYEBROW_BY_CONTEXT[contextType];
}

/**
 * Only a `case` carries per-meeting money, an ordinal line and a resolve prompt. Stated ONCE
 * here so the three surfaces cannot drift apart.
 */
export function contextIsCase(contextType: RecapContextType): boolean {
  return contextType === 'case';
}
