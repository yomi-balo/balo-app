import type { CreatedMeeting } from '@balo/db';
import type { FastifyBaseLogger } from 'fastify';
import type { CalendarProjectedContextType } from './calendar-context-registry.js';
import {
  projectBookingToExpertCalendar,
  type ExpertCalendarDelivery,
} from './project-booking-to-calendar.js';
import { resolveExpertCalendarFacts } from './resolve-calendar-facts.js';

/**
 * BAL-433 Slice 1 — THE ENTRY POINT: one committed booking → one expert-party calendar entry.
 *
 * ⚠ NO GATE. As of BAL-433 EVERY bookable context projects. `isCalendarProjectedContext` is
 * gone and must not be reintroduced: exhaustiveness now lives in
 * `CALENDAR_CONTEXT_REGISTRY`'s `Record`, so a sixth bookable label fails
 * `pnpm --filter api typecheck` there rather than silently reaching no calendar.
 *
 * ⚠ EXPERT SIDE ONLY. `calendar_connections` is keyed on `expert_profile_id` and there is no
 * client-side connection model anywhere in the repo, so no vendor path to a client's calendar
 * exists. The CLIENT-party row — always `delivery_mode='ics'` — is BAL-475's, and it is one
 * `recordIcsDelivery({ meetingId, party: 'client' })` call, not a migration.
 *
 * ⚠ NEVER THROWS (ADR-1044 D2c). The booking has already committed and must never be undone
 * by a best-effort projection.
 */

/**
 * The web origin used to build the MEMBER join route — never `meetings.join_url` (the raw
 * Daily URL). Moved here from `provision-meeting.ts`, whose only reader was the projection.
 */
const WEB_BASE_URL = process.env.APP_URL ?? 'https://balo.expert';

export type { ExpertCalendarDelivery };

/**
 * Project ONE committed booking to the expert's calendar, and report what it became.
 *
 * The return value is for ANALYTICS ONLY (`meeting_calendar_projected`) — no caller branches
 * on it, and none should: every outcome, including `'failed'`, leaves the booking standing.
 */
export async function projectBookingCalendarEvent(
  created: CreatedMeeting,
  contextType: CalendarProjectedContextType,
  contextId: string,
  log: FastifyBaseLogger
): Promise<ExpertCalendarDelivery> {
  const { expertProfileId } = created;
  if (expertProfileId === null) {
    // Structurally unreachable: a `match`-routed `project_discovery` cannot be booked at all
    // (`resolveMeetingExpertTx` throws `MatchModeDiscoveryNotBookableError` before commit),
    // and `CreatedMeeting` types this nullable only for `admin` meetings, which are not
    // bookable. Answered rather than asserted away.
    log.error(
      { meetingId: created.meeting.id, contextType, contextId },
      'A booking resolved no expertProfileId — skipping the calendar projection'
    );
    return 'skipped';
  }

  const facts = await resolveExpertCalendarFacts(contextType, contextId, log);
  if (facts === undefined) {
    return 'skipped';
  }

  return projectBookingToExpertCalendar(
    {
      meetingId: created.meeting.id,
      // ⚠ `created.expertProfileId`, NEVER `resolveContextOwner`'s. This is the answer the
      // consultation projection committed the booking on, and the one that actually blocks
      // availability; two answers to "whose calendar" is exactly the drift this repo forbids.
      expertProfileId,
      clientCompanyName: facts.clientCompanyName,
      caseTitle: facts.title,
      eventLabel: facts.eventLabel,
      startAt: created.meeting.scheduledStart,
      endAt: created.meeting.scheduledEnd,
      // ⚠ BALO'S MEMBER JOIN ROUTE, NEVER `meetings.join_url` (the raw Daily URL). It is the
      // ONLY link a calendar artefact carries (BAL-433 D4): `/packages/…` does not exist and
      // `/engagements/[id]` 404s a case id, and a calendar entry outlives the meeting — a
      // dead link inside one is worse than no link.
      joinUrl: `${WEB_BASE_URL}/join/m/${created.meeting.id}`,
    },
    log
  );
}
