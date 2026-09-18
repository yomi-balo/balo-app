import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';
import { hrefForMeeting, type MeetingHrefSubject } from './href-for-meeting';

/**
 * BAL-435 — "Back to {context}" — the ONE place a meeting context becomes a DESTINATION LABEL.
 *
 * ⚠⚠ THE HREF IS NO LONGER DECIDED HERE. BAL-567 (R6) consolidated the routing half onto
 * {@link hrefForMeeting}, which was already the shared context→href rule for the dashboard Up
 * next card and the expert Calendar. This module kept a SECOND table of its own, and the two had
 * drifted in two ways that mattered:
 *
 *   1. `case` pointed at `/consultations` because `/cases/{id}` did not exist when BAL-435
 *      shipped. It does now, and `/consultations` permanently redirects to `/cases`.
 *   2. `request_interaction` built `/projects/{contextId}` from a
 *      `request_expert_relationships.id` — a confident link to the wrong entity, every time.
 *      `hrefForMeeting` resolves that arm through `projectRequestId` instead, so consolidating
 *      FIXES the bug rather than merely moving it. (The SAME wrong-id mistake lived in
 *      `apps/api`'s `resolve-meeting-context-label.ts`, where it silently nulled the in-call
 *      heading; both were fixed in BAL-567. If one of them regresses, check the other.)
 *
 * What stays here is the WORDS: the label table and the noun table. Those are this module's
 * reason to exist, and R6 preserved them verbatim.
 *
 * ⚠⚠ IT IS **NOT** `resolveEyebrow`, AND IT DELIBERATELY DOES NOT REUSE IT. Two reasons:
 *
 *   1. IT IS DIFFERENT DATA. `resolveEyebrow` returns a meeting-KIND noun ("Consultation",
 *      "Intro call"). This returns a DESTINATION label ("Back to the case"). Reusing it would
 *      produce the wrong words.
 *   2. Its key type excludes `admin` for a RECAP-GATE reason; this one excludes it for a
 *      MEMBER-JOIN reason (an admin meeting has no holder, resolves on the PLATFORM axis, and
 *      never reaches a member join grant at all). Coincidentally the same six labels, for two
 *      independent causes — coupling them would let one ticket's gate silently rewrite the
 *      other's copy.
 *
 * ⚠ SENTENCE CASE, STORED. Any uppercasing is CSS: assistive tech spells short all-caps strings
 * out letter by letter.
 */

export interface BackTo {
  readonly label: string;
  readonly href: string;
}

/**
 * The subject a "Back to …" link is about.
 *
 * ⚠ BAL-567 — IT IS NOW {@link MeetingHrefSubject} ITSELF, re-exported under this name so the
 * call sites that speak of a "back-to subject" keep reading naturally. Declaring a second,
 * structurally-similar interface is how the two href tables drifted apart in the first place; an
 * alias cannot drift.
 */
export type BackToSubject = MeetingHrefSubject;

/**
 * ⚠⚠ TOTAL OVER THE SIX HOLDER-BEARING LABELS, WITH **NO `default:` ARM**. A seventh label added
 * to the enum fails `tsc` HERE rather than shipping a raw enum value to a person mid-call. Same
 * precedent as `resolve-eyebrow.ts`.
 *
 * ⚠ LABELS ONLY, as of BAL-567. Each value used to be a `(contextId) => BackTo` that returned a
 * label AND an href; the href half moved to `hrefForMeeting`.
 */
const BACK_TO_LABEL: Record<MeetingContextTypeWithHolder, string> = {
  case: 'Back to the case',
  project_discovery: 'Back to the project request',
  project_kickoff: 'Back to the project',
  package_session: 'Back to the package',
  retainer_checkin: 'Back to the retainer',
  // ⚠ MJ copy checkpoint (Q3, ACCEPTED): the recap's eyebrow calls this meeting kind an "Intro
  // call"; this names the DESTINATION, which is the request.
  request_interaction: 'Back to the request',
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
 * ⚠⚠ IT STAYS **TOTAL** (BAL-567 / D6). `hrefForMeeting` is partial — it answers `null` for an
 * unverified owning row, for a request-grain arm with no resolved request, and for the two
 * declared-but-unbuilt engagement kinds that have no detail route at all. Every one of those
 * lands on {@link DASHBOARD_BACK_TO}, which is this module's own already-documented fallback for
 * "a member whose context did not resolve".
 *
 * That is NOT the silent-wrong-href pattern R6 forbade. The dashboard is an HONEST destination:
 * it does not claim to be the case or the request, and every member has one. What R6 was aimed at
 * is the `/projects/{relationshipId}` class of bug — a link that points confidently at the WRONG
 * entity — which is exactly what consolidating removed. Making this partial instead would push a
 * `BackTo | null` through `meeting-route-context.tsx` and three components downstream to buy
 * nothing a member can see.
 *
 * ⚠ `package_session` / `retainer_checkin` NOW REACH THE FALLBACK, and that is a fix too: they
 * used to render `/engagements/{contextId}`, which 404s — those ids are not project engagements.
 * Both kinds are declared-but-unbuilt, so no live row exists to have been affected.
 *
 * ⚠ `null` in — no context resolved, or a GUEST, who has no Balo dashboard of their own but is
 * never given this link at all (the provider is mounted only on the member route) — yields the
 * same fallback rather than a dead link.
 */
export function resolveBackTo(context: BackToSubject | null): BackTo {
  if (context === null) return DASHBOARD_BACK_TO;
  const href = hrefForMeeting(context);
  return href === null ? DASHBOARD_BACK_TO : { label: BACK_TO_LABEL[context.contextType], href };
}

/**
 * "case" / "project" / "package" / "retainer" / "request", or `'call'` when nothing resolved.
 *
 * ⚠ `'call'` IS THE FALLBACK RATHER THAN A GUESS. "…all stay with the call" is true of every
 * context; naming the wrong one on a destructive confirm is not.
 *
 * ⚠ IT DOES **NOT** CONSULT `hrefForMeeting`, deliberately. The noun says what the meeting
 * BELONGS TO, which `contextType` alone answers; whether that thing has a reachable page is a
 * separate question. A `package_session` is still "a package" on the confirm dialog even though
 * no `/packages/{id}` route exists for `resolveBackTo` to link to.
 */
export function resolveContextNoun(context: BackToSubject | null): string {
  if (context === null) return 'call';
  return CONTEXT_NOUN[context.contextType];
}
