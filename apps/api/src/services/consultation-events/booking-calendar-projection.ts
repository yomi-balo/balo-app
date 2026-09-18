import { meetingCalendarEventsRepository, type CreatedMeeting } from '@balo/db';
import type { FastifyBaseLogger } from 'fastify';
import type { CalendarProjectedContextType } from './calendar-context-registry.js';
import { memberCallUrl } from './member-call-url.js';
import {
  projectBookingToExpertCalendar,
  type ExpertCalendarDelivery,
} from './project-booking-to-calendar.js';
import { resolveExpertCalendarFacts } from './resolve-calendar-facts.js';

/**
 * BAL-433 Slice 1 — THE ENTRY POINT: one committed booking → one expert-party calendar entry.
 * BAL-475 adds the sibling CLIENT-party entry (`recordClientCalendarEntry`, below) — always
 * `ics`, since there is no client-side vendor connection model in the repo.
 *
 * ⚠ NO GATE. As of BAL-433 EVERY bookable context projects. `isCalendarProjectedContext` is
 * gone and must not be reintroduced: exhaustiveness now lives in
 * `CALENDAR_CONTEXT_REGISTRY`'s `Record`, so a sixth bookable label fails
 * `pnpm --filter api typecheck` there rather than silently reaching no calendar.
 *
 * ⚠ EXPERT SIDE ONLY (`runExpertCalendarProjection`/`projectBookingCalendarEvent`).
 * `calendar_connections` is keyed on `expert_profile_id` and there is no client-side connection
 * model anywhere in the repo, so no vendor path to a client's calendar exists. The CLIENT-party
 * row — always `delivery_mode='ics'` — is `recordClientCalendarEntry`'s, one
 * `recordIcsDelivery({ meetingId, party: 'client' })` call, not a migration.
 *
 * ⚠ NEVER THROWS (ADR-1044 D2c). The booking has already committed and must never be undone
 * by a best-effort projection. BAL-475 delivers the ICS itself from these rows (never from this
 * file — see `services/calendar-invites/publish-calendar-invites.ts`).
 */

export type { ExpertCalendarDelivery };

/**
 * The projection itself — every branch that decides WHAT this booking's expert-party calendar
 * entry becomes, and nothing else.
 *
 * ⚠ EXTRACTED PURELY SO THE OUTCOME IS LOGGED IN EXACTLY ONE PLACE. Four scattered returns
 * meant four chances to forget the log line, and the most important outcome —
 * `'provider_event'`, an event actually written to a real calendar — was the one that had no
 * line at all. The branches, and the value each of them returns, are UNCHANGED.
 */
async function runExpertCalendarProjection(
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

  const facts = await resolveExpertCalendarFacts(
    { meetingId: created.meeting.id, contextType, contextId },
    log
  );
  if (facts === undefined) {
    return 'skipped';
  }

  return projectBookingToExpertCalendar(
    {
      meetingId: created.meeting.id,
      // ⚠ CARRIED FOR LOGGING ONLY. It selects nothing and titles nothing down there — the
      // registry already resolved both — but without it the writer's own two lines cannot say
      // WHICH kind of booking reached a calendar.
      contextType,
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
      joinUrl: memberCallUrl(created.meeting.id),
    },
    log
  );
}

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
  const deliveryMode = await runExpertCalendarProjection(created, contextType, contextId, log);

  /**
   * ⚠⚠ THE ONE LINE AXIOM QUERIES (BAL-433 AC). Emitted on EVERY outcome —
   * `'provider_event'`, `'ics'`, `'skipped'`, `'failed'` — so "did this booking reach a
   * calendar?" is one query over one key set, never an inference from which lines are absent.
   * The inner modules' own lines explain WHY an outcome happened; this one states THAT it did.
   *
   * ⚠ IDS AND CLOSED ENUMS ONLY. `party`, `contextType` and `deliveryMode` are closed
   * vocabularies and `meetingId`/`contextId` are uuids — no company name, no title, no expert
   * name, no provider, no calendar id, nothing derived from an address (ADR-1044 §4). That is
   * what makes an operational log of every booking safe to keep.
   *
   * ⚠ `sequence` IS DELIBERATELY ABSENT, STILL, NOT FORGOTTEN. `meeting_calendar_events` now
   * HAS a `sequence` column (BAL-475), but no ICS is sent from this line — it is a PROJECTION
   * outcome, not a SEND outcome — so there is no SEQUENCE for this line to report. SEQUENCE
   * lives on the calendar-invite publish/delivery outcome lines instead
   * (`services/calendar-invites/log-fields.ts`), which is where it actually changes.
   */
  log.info(
    { meetingId: created.meeting.id, party: 'expert', contextType, contextId, deliveryMode },
    'Meeting calendar projection outcome'
  );

  return deliveryMode;
}

/** What the CLIENT-party row became — narrower than {@link ExpertCalendarDelivery} because
 *  there is no vendor path on this side, only ICS or a swallowed failure. */
export type ClientCalendarDelivery = 'ics' | 'failed';

/**
 * BAL-475 — the CLIENT-party row for one FRESH booking: always `ics` (no client vendor path in
 * V1). NEVER THROWS. Emits the SAME `'Meeting calendar projection outcome'` line the expert
 * side does, with `party: 'client'`, so one Axiom query covers both parties.
 */
export async function recordClientCalendarEntry(
  meetingId: string,
  contextType: CalendarProjectedContextType,
  contextId: string,
  log: FastifyBaseLogger
): Promise<ClientCalendarDelivery> {
  let deliveryMode: ClientCalendarDelivery;
  try {
    await meetingCalendarEventsRepository.recordIcsDelivery({ meetingId, party: 'client' });
    deliveryMode = 'ics';
  } catch (error) {
    log.error(
      {
        meetingId,
        party: 'client',
        contextType,
        contextId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Client calendar projection failed'
    );
    deliveryMode = 'failed';
  }

  log.info(
    { meetingId, party: 'client', contextType, contextId, deliveryMode },
    'Meeting calendar projection outcome'
  );

  return deliveryMode;
}
