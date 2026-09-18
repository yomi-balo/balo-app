import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

/**
 * BAL-566 (D6) — the shared "where does this meeting link to" rule, extracted VERBATIM from
 * `expert/calendar/_lib/load-expert-calendar.ts` so the dashboard Up next card and the expert
 * calendar cannot drift.
 *
 * PURE, no `server-only` — both a client-safe view model builder (dashboard `build-up-next-rows.ts`)
 * and a server-only loader (`load-expert-calendar.ts`) call this.
 *
 * ⚠⚠ BAL-567 (R6) — THIS IS NOW THE **ONLY** CONTEXT→HREF TABLE. `back-to-context.ts` used to
 * carry a second one (with a wrong `request_interaction` id, and a `case` arm still pointing at
 * `/consultations`); it now calls this function and keeps only the LABELS and the prose nouns.
 * Extend this module, not that one — and if a third surface needs a meeting's destination, it
 * calls `hrefForMeeting` too rather than starting a fourth table.
 *
 * ⚠ IT IS PARTIAL, AND EVERY CALLER MUST HANDLE `null`. Three shapes answer `null`: an unverified
 * owning row, a request-grain arm with no resolved `projectRequestId`, and the two
 * declared-but-unbuilt engagement kinds that have no detail route. `resolveBackTo` maps all three
 * onto its documented `DASHBOARD_BACK_TO` fallback; the Up next card renders an un-linked row.
 */
export interface MeetingHrefSubject {
  readonly owningRowFound: boolean;
  readonly contextType: MeetingContextTypeWithHolder;
  /**
   * The winning `meeting_contexts.context_id` — `null` whenever {@link owningRowFound} is
   * `false`. That column crosses a seam with no FK and no RLS, so an unverified value is another
   * tenant's identifier, not this viewer's (BAL-498 fix round 3, R8).
   */
  readonly contextId: string | null;
  /** `project_requests.id` — non-null for the two request-grain labels only (the link target). */
  readonly projectRequestId: string | null;
}

/**
 * Resolved server- or client-side. `null` whenever the repository could not resolve a LIVE
 * owning row for this viewer (`owningRowFound === false`) — REGARDLESS of arm. `contextId`/
 * `projectRequestId` are not trustworthy on their own: `meeting_contexts.context_id` has no FK
 * and no RLS, so a drifted or forged row (or a soft-deleted owning engagement/request) can carry
 * a value that resolved to nobody. Rendering it as a live `href` in that case would leak another
 * tenant's identifier into this viewer's page even though the repository already refused to name
 * the counterparty (security-bal-498.md MEDIUM finding). This is the SAME discipline the
 * `request_interaction` arm always applied — now applied uniformly to all four arms.
 */
export function hrefForMeeting(meeting: MeetingHrefSubject): string | null {
  // `contextId` is nulled by the repository alongside every other identity field whenever the
  // owning row could not be verified (BAL-498 fix round 3, R8) — the second conjunct is the
  // compiler's proof of that, not a second policy.
  if (!meeting.owningRowFound || meeting.contextId === null) {
    return null;
  }
  switch (meeting.contextType) {
    case 'case':
      return `/cases/${meeting.contextId}`;
    case 'project_kickoff':
      return `/engagements/${meeting.contextId}`;
    case 'project_discovery':
    case 'request_interaction':
      // Both request-grain labels resolve their link target through the VERIFIED
      // `projectRequestId` the repository already resolved — never the raw `contextId`
      // (security-bal-498.md: `project_discovery`'s contextId IS the request id, but reaching
      // for it here bypasses the `owningRowFound` gate's sibling discipline of "use the
      // resolved column, not the polymorphic one").
      return meeting.projectRequestId === null ? null : `/projects/${meeting.projectRequestId}`;
    case 'package_session':
    case 'retainer_checkin':
      // No detail route exists — these engagement kinds are declared-but-unbuilt.
      return null;
    default: {
      const unhandled: never = meeting.contextType;
      throw new Error(`Unhandled meeting context type: ${String(unhandled)}`);
    }
  }
}
