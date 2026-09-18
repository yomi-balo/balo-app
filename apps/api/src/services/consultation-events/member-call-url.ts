/**
 * BAL-475 §7.5 — the ONE definition of a Balo MEMBER's in-call route, absolute. Moved from
 * `booking-calendar-projection.ts` (`WEB_BASE_URL` + an inline template), which is now its only
 * pre-existing caller; the ICS invite's display-facts resolver
 * (`services/calendar-invites/resolve-calendar-invite-facts.ts`) is the second.
 *
 * ⚠ NEVER `meetings.join_url` (the raw Daily URL) — this is Balo's OWN member route, the only
 * link a calendar artefact carries (BAL-433 D4). It outlives the meeting; a dead link inside a
 * calendar entry is worse than no link.
 *
 * ⚠⚠ BAL-567 REPOINTED THIS FROM `/join/m/{id}` TO `/meetings/{id}/call`, AND IT IS THE THIRD
 * MEMBER-FACING PRODUCER, NOT A NOTIFICATION TEMPLATE. It feeds the BAL-475 ICS facts and the
 * booking calendar projection, so a member clicking the link in their own calendar entry used to
 * land in the ANONYMOUS GUEST LOBBY — name + email, no session read, and for a `case` meeting no
 * metered credit session at all, because that opens only inside `joinMeetingAsMember`. The lobby
 * builder (`apps/web/src/lib/meetings/join-link.ts`) is a DIFFERENT function and stays exactly as
 * it is: guest calendar artefacts still carry a tokenised guest link, and only the
 * `audience: 'member'` arm of `resolveCalendarInviteFacts` ever reaches this one.
 *
 * ⚠ The shape here must stay in lockstep with `memberCallPath()`
 * (`apps/web/src/lib/meetings/member-call-path.ts`) and with `memberCallPathSchema`
 * (`apps/api/src/routes/notifications/schema.ts`): one route, three producers, two apps that
 * cannot import each other.
 */

/** The web origin used to build the MEMBER call route. */
const WEB_BASE_URL = process.env.APP_URL ?? 'https://balo.expert';

/** `${WEB_BASE_URL}/meetings/{meetingId}/call` — the member's in-call route for one meeting. */
export function memberCallUrl(meetingId: string): string {
  return `${WEB_BASE_URL}/meetings/${meetingId}/call`;
}
