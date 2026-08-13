import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

/**
 * BAL-435 — "Back to {context}" — the ONE place a meeting context becomes a DESTINATION.
 *
 * ⚠⚠ IT IS **NOT** `resolveEyebrow`, AND IT DELIBERATELY DOES NOT REUSE IT. Three reasons, in
 * order of weight:
 *
 *   1. IT IS DIFFERENT DATA. `resolveEyebrow` returns a meeting-KIND noun ("Consultation",
 *      "Intro call"). This returns a DESTINATION label plus an href ("Back to the case" →
 *      `/consultations`). Reusing it would produce the wrong words.
 *   2. Promoting it would mean editing BAL-388's route-private `_lib/`, which this ticket does
 *      not touch.
 *   3. Its key type excludes `admin` for a RECAP-GATE reason; this one excludes it for a
 *      MEMBER-JOIN reason (an admin meeting has no holder, resolves on the PLATFORM axis, and
 *      never reaches a member join grant at all). Coincidentally the same six labels, for two
 *      independent causes — coupling them would let one ticket's gate silently rewrite the
 *      other's copy.
 *
 * ⚠ SENTENCE CASE, STORED. Any uppercasing is CSS: assistive tech spells short all-caps strings
 * out letter by letter.
 *
 * ⚠⚠ NEVER RENDER A DEAD LINK. `/cases/[caseId]` is BAL-421 and does not exist yet, so `case`
 * points at `/consultations` — as a TABLE ENTRY, not an inline `??` at a call site, so there is
 * one place to change when BAL-421 lands.
 */

export interface BackTo {
  readonly label: string;
  readonly href: string;
}

/**
 * The subject a "Back to …" link is about — the two fields `MemberJoinContext` supplies.
 * ⚠ Structurally satisfied by `PrimaryMeetingContext` too, so either shape passes unchanged.
 */
export interface BackToSubject {
  readonly contextType: MeetingContextTypeWithHolder;
  readonly contextId: string;
}

/**
 * ⚠⚠ TOTAL OVER THE SIX HOLDER-BEARING LABELS, WITH **NO `default:` ARM**. A seventh label added
 * to the enum fails `tsc` HERE rather than shipping a raw enum value to a person mid-call. Same
 * precedent as `resolve-eyebrow.ts`.
 */
const BACK_TO: Record<MeetingContextTypeWithHolder, (contextId: string) => BackTo> = {
  // ⚠ `/cases/[caseId]` is BAL-421 — VERIFIED ABSENT today. The label stays correct; the href
  // falls back to the nearest live ancestor.
  case: () => ({ label: 'Back to the case', href: '/consultations' }),
  project_discovery: (id) => ({ label: 'Back to the project request', href: `/projects/${id}` }),
  project_kickoff: (id) => ({ label: 'Back to the project', href: `/engagements/${id}` }),
  package_session: (id) => ({ label: 'Back to the package', href: `/engagements/${id}` }),
  retainer_checkin: (id) => ({ label: 'Back to the retainer', href: `/engagements/${id}` }),
  // ⚠ MJ copy checkpoint (Q3, ACCEPTED): the recap's eyebrow calls this meeting kind an "Intro
  // call"; this names the DESTINATION, which is the request.
  request_interaction: (id) => ({ label: 'Back to the request', href: `/projects/${id}` }),
};

/**
 * The NOUN the same context is called in prose — used by the end-for-everyone confirm dialog.
 *
 * ⚠ ONE SOURCE, TWO RENDERINGS. A second table would be two answers to "what is this thing
 * called", and they would drift on the first copy change.
 */
const CONTEXT_NOUN: Record<MeetingContextTypeWithHolder, string> = {
  case: 'case',
  project_discovery: 'request',
  project_kickoff: 'project',
  package_session: 'package',
  retainer_checkin: 'retainer',
  request_interaction: 'request',
};

/** The honest fallback for a guest, or for a member whose context did not resolve. */
export const DASHBOARD_BACK_TO: BackTo = {
  label: 'Back to your dashboard',
  href: '/dashboard',
};

/**
 * Where "back" goes from this call.
 *
 * ⚠ `null` — no context resolved, or a GUEST, who has no Balo dashboard of their own but is
 * never given this link at all (the provider is mounted only on the member route) — yields the
 * dashboard fallback rather than a dead link.
 */
export function resolveBackTo(context: BackToSubject | null): BackTo {
  if (context === null) return DASHBOARD_BACK_TO;
  return BACK_TO[context.contextType](context.contextId);
}

/**
 * "case" / "project" / "package" / "retainer" / "request", or `'call'` when nothing resolved.
 *
 * ⚠ `'call'` IS THE FALLBACK RATHER THAN A GUESS. "…all stay with the call" is true of every
 * context; naming the wrong one on a destructive confirm is not.
 */
export function resolveContextNoun(context: BackToSubject | null): string {
  if (context === null) return 'call';
  return CONTEXT_NOUN[context.contextType];
}
