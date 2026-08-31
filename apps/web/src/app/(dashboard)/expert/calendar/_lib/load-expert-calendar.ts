import 'server-only';

import { cache } from 'react';
import { fromZonedTime } from 'date-fns-tz';
import { meetingsRepository, expertsRepository, type ExpertCalendarMeeting } from '@balo/db';
import { getChecklistStatus } from '@/lib/actions/expert-checklist';
import { meetingJoinLinkUrl } from '@/lib/meetings/join-link';
import { log } from '@/lib/logging';
import { addDaysToDayKey, todayDayKey } from '@/lib/calendar/zoned-grid';
import type { CalendarMeetingView, CalendarPageView } from './calendar-view-types';

/** The Week grid shows 7 days; the extra padding gives Agenda a reasonable forward horizon
 *  from the same single server query, without a second round trip. */
const WEEK_DAYS = 7;
const AGENDA_HORIZON_PADDING_DAYS = 21;

/**
 * Resolved server-side. `null` whenever the repository could not resolve a LIVE owning row for
 * this expert (`meeting.owningRowFound === false`) — REGARDLESS of arm. `contextId`/
 * `projectRequestId` are not trustworthy on their own: `meeting_contexts.context_id` has no FK
 * and no RLS, so a drifted or forged row (or a soft-deleted owning engagement/request) can carry
 * a value that resolved to nobody. Rendering it as a live `href` in that case would leak another
 * tenant's identifier into this expert's page even though the repository already refused to name
 * the counterparty (security-bal-498.md MEDIUM finding). This is the SAME discipline the
 * `request_interaction` arm always applied — now applied uniformly to all four arms.
 */
function hrefForMeeting(meeting: ExpertCalendarMeeting): string | null {
  // `contextId` is now nulled by the repository alongside every other identity field whenever
  // the owning row could not be verified (BAL-498 fix round 3, R8) — the second conjunct is the
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

/**
 * `expert_profiles.timezone` — resolved ONCE per request (`cache()`d, React de-dupes concurrent
 * calls with identical args within the same render). MUST be resolved before any query range is
 * computed: both the default visible week (`page.tsx`) and this loader's own query range are
 * wrong if built against UTC "today" instead of the expert's own wall clock (BAL-498 fix round 1,
 * B2/B3 — every meeting on the visible week's early days silently vanished for zones east of
 * UTC, and the page landed on last week's grid every morning before ~10:00 local).
 */
export const resolveExpertScheduleTimezone = cache(
  async (expertProfileId: string, userId: string): Promise<string> => {
    // ⚠ SCOPED (BAL-498 fix round 3, S3): `expert_profiles` has no RLS, so the by-id read
    // carries the session's own `userId` as a second predicate. A no-op for a well-formed
    // session; fail-closed (`null` -> the 'UTC' fallback below) if the two ever disagree.
    const timezone = await expertsRepository.findTimezone(expertProfileId, { userId });
    if (timezone === null) {
      log.warn('Expert calendar: findTimezone returned null for a live session', {
        expertProfileId,
      });
      return 'UTC';
    }
    return timezone;
  }
);

export interface LoadExpertCalendarInput {
  readonly expertProfileId: string;
  /** The SESSION's own user id — scopes the `expert_profiles` read (S3). Never a param. */
  readonly userId: string;
  /** Monday-anchored day key (`yyyy-MM-dd`) for the visible week. */
  readonly weekStartDayKey: string;
}

/**
 * Fans out the expert calendar's three independent reads and maps to the client-safe view.
 * `meetingJoinLinkUrl` is `server-only` — computed here, passed down as a plain string.
 *
 * ⚠ TIMEZONE MUST RESOLVE FIRST. The query range is built from a LOCAL day key
 * (`weekStartDayKey`); converting it to the UTC instants the repository needs requires the
 * expert's OWN zone (`fromZonedTime`), never a bare `...T00:00:00.000Z` UTC-literal parse — the
 * latter silently starts the window 8-14h after local midnight for every zone east of UTC and
 * drops real meetings from the query entirely (BAL-498 fix round 1, B2).
 */
export const loadExpertCalendar = cache(async function loadExpertCalendar(
  input: LoadExpertCalendarInput
): Promise<CalendarPageView> {
  const [resolvedTimezone, checklist] = await Promise.all([
    resolveExpertScheduleTimezone(input.expertProfileId, input.userId),
    getChecklistStatus(),
  ]);

  const rangeStart = fromZonedTime(`${input.weekStartDayKey} 00:00:00`, resolvedTimezone);
  const weekRangeEndDayKey = addDaysToDayKey(
    input.weekStartDayKey,
    WEEK_DAYS + AGENDA_HORIZON_PADDING_DAYS
  );
  // Agenda filters `dayKey >= today` INDEPENDENTLY of the visible week (`calendar-shell.tsx`), so
  // paging the Week view BACKWARDS must not also walk the fetch window off the front of Agenda's
  // content. Clamp `rangeEnd` to at least `today + AGENDA_HORIZON` — the forward-paging case is
  // unaffected (`weekRangeEndDayKey` already exceeds it there); a week entirely in the past no
  // longer produces a false "You're all clear" for a call that is actually two hours away
  // (BAL-498 fix round 2, N5). Day keys are `yyyy-MM-dd`, zero-padded — lexicographic string
  // comparison IS calendar-date comparison.
  const agendaHorizonEndDayKey = addDaysToDayKey(
    todayDayKey(resolvedTimezone),
    WEEK_DAYS + AGENDA_HORIZON_PADDING_DAYS
  );
  const rangeEndDayKey =
    weekRangeEndDayKey > agendaHorizonEndDayKey ? weekRangeEndDayKey : agendaHorizonEndDayKey;
  const rangeEnd = fromZonedTime(`${rangeEndDayKey} 00:00:00`, resolvedTimezone);

  const meetings = await meetingsRepository.listCalendarForExpert({
    expertProfileId: input.expertProfileId,
    rangeStart,
    rangeEnd,
  });

  const meetingViews: CalendarMeetingView[] = meetings.map((meeting) => ({
    meetingId: meeting.meetingId,
    scheduledStart: meeting.scheduledStart.toISOString(),
    scheduledEnd: meeting.scheduledEnd.toISOString(),
    contextType: meeting.contextType,
    href: hrefForMeeting(meeting),
    joinUrl: meetingJoinLinkUrl(meeting.meetingId),
    counterpartyCompanyName: meeting.counterpartyCompanyName,
  }));

  return {
    expertProfileId: input.expertProfileId,
    timezone: resolvedTimezone,
    meetings: meetingViews,
    hasConnectedCalendar: checklist.items.calendar,
  };
});
