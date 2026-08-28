import type { MeetingContextTypeLabel } from '@balo/shared/meetings';

/**
 * BAL-439 — MOVED out of `[token]/page.tsx`, not copied (the repo's stated rule for a second
 * consumer). Both consumers of this label — the invitation landing and the guest recap header
 * (`recap/_lib/load-guest-recap.ts`) — live under `[token]/`, so this is their honest home. That
 * placement is also what keeps this file off the no-lens gate's lists entirely (§7 of the plan):
 * it is not a `lib/meetings/*` module.
 *
 * Human labels for the primary `meeting_contexts.context_type`.
 *
 * TOTAL BY CONSTRUCTION (`Record<MeetingContextTypeLabel, string>`): an eighth context type
 * added to the pgEnum fails `pnpm typecheck` here until it is given a guest-facing name, rather
 * than silently rendering the generic fallback.
 *
 * ⚠ `admin` IS UNREACHABLE THROUGH THIS MAP and is listed anyway. `selectPrimaryMeetingContext`
 * scores it 0 and DROPS it, so an admin-only meeting resolves to `{ ok: false, reason: 'none' }`
 * and lands on {@link GENERIC_CONTEXT_LABEL} via the `null` argument below. Listing it keeps the
 * record total; deleting it would make the type non-exhaustive and hide the next enum addition.
 */
const CONTEXT_LABELS: Record<MeetingContextTypeLabel, string> = {
  case: 'Consultation',
  project_kickoff: 'Project kickoff',
  package_session: 'Package session',
  retainer_checkin: 'Check-in',
  request_interaction: 'Intro call',
  project_discovery: 'Discovery call',
  admin: 'Meeting',
};

/** What an unresolvable / ambiguous / admin-only context is called. Names nothing. */
const GENERIC_CONTEXT_LABEL = 'Meeting';

/**
 * The guest-facing label for a resolved primary context, or the generic fallback for `null` —
 * the caller's own way of saying "no primary context resolved" (`!primary.ok`, or an `admin`
 * meeting, which `selectPrimaryMeetingContext` never returns as a primary in the first place).
 */
export function guestContextLabel(contextType: MeetingContextTypeLabel | null): string {
  return contextType === null ? GENERIC_CONTEXT_LABEL : CONTEXT_LABELS[contextType];
}
