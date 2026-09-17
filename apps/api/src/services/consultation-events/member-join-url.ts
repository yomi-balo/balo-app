/**
 * BAL-475 §7.5 — the ONE definition of a Balo MEMBER's join route. Moved from
 * `booking-calendar-projection.ts` (`WEB_BASE_URL` + the inline `${WEB_BASE_URL}/join/m/{id}`
 * template), which is now its only pre-existing caller; the ICS invite's display-facts resolver
 * (`services/calendar-invites/resolve-calendar-invite-facts.ts`) is the second.
 *
 * ⚠ NEVER `meetings.join_url` (the raw Daily URL) — this is Balo's OWN member route, the only
 * link a calendar artefact carries (BAL-433 D4). It outlives the meeting; a dead link inside a
 * calendar entry is worse than no link.
 */

/** The web origin used to build the MEMBER join route. */
const WEB_BASE_URL = process.env.APP_URL ?? 'https://balo.expert';

/** `${WEB_BASE_URL}/join/m/{meetingId}` — the member join route for one meeting. */
export function memberJoinUrl(meetingId: string): string {
  return `${WEB_BASE_URL}/join/m/${meetingId}`;
}
