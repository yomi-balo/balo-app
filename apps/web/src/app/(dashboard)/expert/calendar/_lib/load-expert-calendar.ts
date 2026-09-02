import 'server-only';

import { cache } from 'react';
import { fromZonedTime } from 'date-fns-tz';
import { meetingsRepository, expertsRepository, type ExpertCalendarMeeting } from '@balo/db';
import { getChecklistStatus } from '@/lib/actions/expert-checklist';
import { meetingJoinLinkUrl } from '@/lib/meetings/join-link';
import { log } from '@/lib/logging';
import { addDaysToDayKey, todayDayKey } from '@/lib/calendar/zoned-grid';
import type { CalendarMeetingView, CalendarPageView } from './calendar-view-types';

/** Window (a): the Week grid's own range — the visible Monday through the following Monday. */
const WEEK_DAYS = 7;

/**
 * Window (b): the Agenda list's forward horizon FROM TODAY. Fetched on every request, independently
 * of which week is visible, because `calendar-shell.tsx` filters Agenda on `dayKey >= today` and has
 * no idea which week the Week grid is showing.
 *
 * ⚠ 28, NOT 21. This replaces the retired `AGENDA_HORIZON_PADDING_DAYS`, which was 21 and was only
 * ever used as `WEEK_DAYS + AGENDA_HORIZON_PADDING_DAYS`. Reading the old name as a horizon silently
 * shrinks Agenda by a week (BAL-513 D5).
 *
 * ⚠ KEEP UNDER `MAX_CALENDAR_RANGE_DAYS` (35, `packages/db/src/repositories/meetings.ts`). That
 * constant is now sized against THIS number; widening the horizon without widening it throws
 * `CalendarRangeTooWideError` on every page load.
 */
const AGENDA_HORIZON_DAYS = 28;

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
 * Fans out the expert calendar's four independent reads and maps to the client-safe view.
 * `meetingJoinLinkUrl` is `server-only` — computed here, passed down as a plain string.
 *
 * ⚠ TIMEZONE MUST RESOLVE FIRST. Both query windows are built from LOCAL day keys
 * (`weekStartDayKey`, and today's own day key); converting them to the UTC instants the
 * repository needs requires the expert's OWN zone (`fromZonedTime`), never a bare
 * `...T00:00:00.000Z` UTC-literal parse — the latter silently starts the window 8-14h after
 * local midnight for every zone east of UTC and drops real meetings from the query entirely
 * (BAL-498 fix round 1, B2).
 *
 * Since BAL-513, the calendar issues TWO bounded reads rather than one stretched one: the
 * visible week (`WEEK_DAYS`) and the Agenda horizon (`AGENDA_HORIZON_DAYS`, anchored on today),
 * fetched together via `Promise.all` and merged — see `mergeCalendarWindows`.
 */
export const loadExpertCalendar = cache(async function loadExpertCalendar(
  input: LoadExpertCalendarInput
): Promise<CalendarPageView> {
  const [resolvedTimezone, checklist] = await Promise.all([
    resolveExpertScheduleTimezone(input.expertProfileId, input.userId),
    getChecklistStatus(),
  ]);

  // ⚠ ONE zone, resolved above, for BOTH windows. `fromZonedTime` on a LOCAL day key, never a
  // `...T00:00:00.000Z` UTC-literal parse — see this function's docblock (BAL-498 fix round 1, B2).
  const zonedMidnight = (dayKey: string): Date =>
    fromZonedTime(`${dayKey} 00:00:00`, resolvedTimezone);

  // Window (a) — THE VISIBLE WEEK, exactly 7 days. No `−1 day` lookback: the repository's overlap
  // predicate is `startAt < rangeEnd AND endAt > rangeStart` (`meetings.ts`), so a meeting that
  // starts on the preceding Sunday and crosses local midnight into Monday is already returned. That
  // is what makes `calendar-shell.tsx`'s `previousWeekLookbackDayKey` filter work, and it keeps
  // working unchanged.
  const weekRangeStart = zonedMidnight(input.weekStartDayKey);
  const weekRangeEnd = zonedMidnight(addDaysToDayKey(input.weekStartDayKey, WEEK_DAYS));

  // Window (b) — THE AGENDA HORIZON, anchored on TODAY and never on the visible week. This is what
  // the deleted N5 `rangeEnd` clamp was buying, bought properly: paging the Week view backwards used
  // to stretch ONE query from the far-past Monday all the way forward to `today + 28`, up to a
  // ~399-day scan that could trip the repository's 2,000-row fail-closed cap and land the expert on
  // `error.tsx`. Two bounded reads cost one extra round trip and remove the whole class.
  const todayKey = todayDayKey(resolvedTimezone);
  const agendaRangeStart = zonedMidnight(todayKey);
  const agendaRangeEnd = zonedMidnight(addDaysToDayKey(todayKey, AGENDA_HORIZON_DAYS));

  // ⚠ ARGUMENT ORDER IS PART OF THE CONTRACT: week first, agenda second. `load-expert-calendar.test.ts`
  // sequences its per-window mocks on it and pins it with its own test.
  const [weekWindow, agendaWindow] = await Promise.all([
    readCalendarWindow('week', {
      expertProfileId: input.expertProfileId,
      rangeStart: weekRangeStart,
      rangeEnd: weekRangeEnd,
    }),
    readCalendarWindow('agenda', {
      expertProfileId: input.expertProfileId,
      rangeStart: agendaRangeStart,
      rangeEnd: agendaRangeEnd,
    }),
  ]);

  const meetings = mergeCalendarWindows(weekWindow, agendaWindow);

  const meetingViews: CalendarMeetingView[] = meetings.map((meeting) => ({
    meetingId: meeting.meetingId,
    scheduledStart: meeting.scheduledStart.toISOString(),
    scheduledEnd: meeting.scheduledEnd.toISOString(),
    status: meeting.status, // @balo/db `MeetingStatus` → shared `MeetingLifecycleStatus`, no cast — see D2 §status
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

/**
 * ONE labelled read, so a throw names WHICH window failed and with what bounds (BAL-513 D8).
 *
 * ⚠ LOGS AND RE-THROWS — a deliberate, narrow exception to CLAUDE.md's "log where you HANDLE".
 * `page.tsx:93-101` remains the boundary that renders `error.tsx`; swallowing here would show an
 * empty calendar instead of a retry. What this adds is the one fact `page.tsx` structurally cannot
 * know: with two `Promise.all`'d reads its `weekStartDayKey`-only log no longer identifies the
 * failing query. Two records, one incident — the AsyncLocalStorage mixin puts the same `requestId`
 * on both.
 */
async function readCalendarWindow(
  window: 'week' | 'agenda',
  args: { expertProfileId: string; rangeStart: Date; rangeEnd: Date }
): Promise<ExpertCalendarMeeting[]> {
  try {
    return await meetingsRepository.listCalendarForExpert(args);
  } catch (error) {
    log.error('Expert calendar window read failed', {
      window,
      expertProfileId: args.expertProfileId,
      rangeStart: args.rangeStart.toISOString(),
      rangeEnd: args.rangeEnd.toISOString(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Merge the two bounded windows into ONE ascending, de-duplicated list.
 *
 * ⚠⚠ CONCATENATION ALONE DOES NOT PRESERVE ORDER (BAL-513 D7). The repository sorts WITHIN each call
 * (`orderBy(asc(meetings.scheduledStart), asc(meetings.id))`), so `[week] ++ [agenda]` is globally
 * ascending only by accident. Two live counter-examples:
 *   · a FORWARD-paged week — `[October] ++ [today..today+28]` is descending at the seam;
 *   · the CURRENT week — `[Mon, Fri] ++ [Thu, Fri, next Tue]` interleaves.
 * Re-sorting with the repository's OWN comparator makes the merged list indistinguishable from a
 * single `orderBy(asc(scheduledStart), asc(id))` query — that indistinguishability is the LOADER'S
 * PUBLISHED CONTRACT, and every downstream filter was written against it. `WeekGrid`
 * (`week-grid.tsx:181-183`) and `AgendaList` (`agenda-list.tsx:68`, day-group order; `:73-75`,
 * within-group) both happen to re-sort defensively on their own, so this re-sort is contract-keeping,
 * not render-fixing — no downstream consumer actually depends on the handed order.
 *
 * ⚠ FIRST WRITER WINS on a duplicate. The two windows overlap whenever the visible week is the
 * current one, and both copies come from the same repository, the same `select`, and the same fold,
 * so they are structurally identical and which one survives is immaterial.
 */
export function mergeCalendarWindows(
  ...windows: readonly (readonly ExpertCalendarMeeting[])[]
): ExpertCalendarMeeting[] {
  const byId = new Map<string, ExpertCalendarMeeting>();
  for (const window of windows) {
    for (const meeting of window) {
      if (!byId.has(meeting.meetingId)) {
        byId.set(meeting.meetingId, meeting);
      }
    }
  }
  // ⚠ EXPLICIT COMPARATOR (SonarCloud S2871), mirroring `asc(scheduledStart), asc(id)`. The
  // repository orders by BYTE order (`asc(meetings.id)`); `localeCompare` is locale/ICU-dependent
  // and, while equivalent in practice for lowercase-hex UUIDs, is not exact and costs more. A
  // plain relational comparison mirrors the repository's byte-order tie-break precisely.
  //
  // ⚠ BAL-513 fix round 2 (F9) — MUST RETURN 0 ON EQUALITY. `byId` is a `Map` keyed on
  // `meetingId`, so two distinct entries can never carry the same id — this branch is
  // unreachable after the de-dupe above — but `a.meetingId < b.meetingId ? -1 : 1` is not a valid
  // total order regardless (it claims every non-`<` pair is `>`, including an equal pair), which
  // is exactly what Sonar's S2871 ("comparators must return 0 for equal elements") flags. Equal
  // ids ARE possible in principle for two comparators sharing this same relational shape, so this
  // one states the real relation rather than relying on the Map to make the false case
  // unreachable.
  return [...byId.values()].sort((a, b) => {
    const byStart = a.scheduledStart.getTime() - b.scheduledStart.getTime();
    if (byStart !== 0) return byStart;
    if (a.meetingId < b.meetingId) return -1;
    if (a.meetingId > b.meetingId) return 1;
    return 0;
  });
}
