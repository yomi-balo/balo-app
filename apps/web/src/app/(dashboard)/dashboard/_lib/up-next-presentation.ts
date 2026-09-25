import { formatInTimeZone } from 'date-fns-tz';
import { addDaysToDayKey, todayDayKey, zonedDayKey } from '@/lib/calendar/zoned-grid';
import { calendarMeetingTiming, signedMinutesUntilCalendarStart } from '@/lib/calendar/join-window';
import { deriveCaseConsultationState } from '@balo/shared/engagements';
import { rescheduleProposalIsLive } from '@balo/shared/meetings';
import type { DashboardUpNextRowState } from '@balo/analytics/events';
import { UP_NEXT_COPY, UP_NEXT_HAPPENING_NOW, upNextStartsIn } from './up-next-copy';
import type { UpNextRowView, UpNextWorkspaceType } from './up-next-view-types';

/**
 * BAL-566 — pure, client-safe. Time formatting, timing state, and the reschedule note. `now` and
 * `timeZone` are always injected (never `new Date()` / a device read here) so this stays testable
 * and the caller controls the ONE source of "now" (`useViewerClock`).
 */

const MS_PER_MINUTE = 60_000;

/**
 * "Today, 2:30 pm" + "30 min"; "Tomorrow, 9:00 am" + "60 min"; otherwise "Thu 17 Sep" + "3:00 pm,
 * 45 min". Time `'h:mm aaa'` (lowercase am/pm), date `'EEE d MMM'`, both in the VIEWER's zone (R3).
 * Duration = round((end − start) / 60000) scheduled minutes.
 */
export function formatUpNextWhen(
  row: Pick<UpNextRowView, 'scheduledStart' | 'scheduledEnd'>,
  now: Date,
  timeZone: string
): { readonly primary: string; readonly secondary: string } {
  const startIso = row.scheduledStart;
  const durationMinutes = Math.round(
    (new Date(row.scheduledEnd).getTime() - new Date(startIso).getTime()) / MS_PER_MINUTE
  );
  const timeStr = formatInTimeZone(new Date(startIso), timeZone, 'h:mm aaa');
  const dateStr = formatInTimeZone(new Date(startIso), timeZone, 'EEE d MMM');

  const todayKey = todayDayKey(timeZone, now);
  const tomorrowKey = addDaysToDayKey(todayKey, 1);
  const startDayKey = zonedDayKey(startIso, timeZone);

  if (startDayKey === todayKey) {
    return { primary: `Today, ${timeStr}`, secondary: `${durationMinutes} min` };
  }
  if (startDayKey === tomorrowKey) {
    return { primary: `Tomorrow, ${timeStr}`, secondary: `${durationMinutes} min` };
  }
  return { primary: dateStr, secondary: `${timeStr}, ${durationMinutes} min` };
}

export interface UpNextRowTiming {
  /** `!calendarMeetingTiming(...).isPast`. */
  readonly visible: boolean;
  /** `calendarMeetingTiming(...).joinVisible` — −15 min inclusive .. end + 30 min exclusive, non-terminal. */
  readonly joinVisible: boolean;
  readonly rowState: DashboardUpNextRowState;
  /** `starting_soon` → `upNextStartsIn(n)`; `happening_now` → `UP_NEXT_HAPPENING_NOW`; `upcoming` → `null`. */
  readonly statusLine: string | null;
  /** `calendarMeetingTiming`'s aria suffix. */
  readonly joinTimingLabel: string | null;
  /** BAL-581 — inside the join window with no ready call room; render `RoomSettingUpSlot`
   *  instead of Join. `false` on the `joinVisible` arm — never both true. */
  readonly roomSettingUp: boolean;
}

/**
 * `happening_now` ⇔ `joinVisible && (status === 'in_progress' || signedMinutes <= 0)` (`−0`
 * counts as `<= 0`); `starting_soon` ⇔ `joinVisible` otherwise; `upcoming` ⇔ `!joinVisible`. No
 * relative status line outside the join window (ORCHESTRATOR RULING 3 — approved as planned).
 */
export function resolveUpNextRowTiming(
  row: Pick<UpNextRowView, 'scheduledStart' | 'scheduledEnd' | 'status' | 'roomReady'>,
  now: Date
): UpNextRowTiming {
  const scheduledStart = new Date(row.scheduledStart);
  const scheduledEnd = new Date(row.scheduledEnd);
  const timing = calendarMeetingTiming(
    now,
    scheduledStart,
    scheduledEnd,
    row.status,
    row.roomReady
  );
  const signedMinutes = signedMinutesUntilCalendarStart(now, scheduledStart);

  if (!timing.joinVisible) {
    return {
      visible: !timing.isPast,
      joinVisible: false,
      rowState: 'upcoming',
      statusLine: null,
      joinTimingLabel: null,
      roomSettingUp: timing.roomSettingUp,
    };
  }

  const happeningNow = row.status === 'in_progress' || signedMinutes <= 0;
  return {
    visible: !timing.isPast,
    joinVisible: true,
    rowState: happeningNow ? 'happening_now' : 'starting_soon',
    statusLine: happeningNow ? UP_NEXT_HAPPENING_NOW : upNextStartsIn(signedMinutes),
    joinTimingLabel: timing.joinTimingLabel,
    roomSettingUp: false,
  };
}

/**
 * D4 — case rows only. Liveness via `rescheduleProposalIsLive` on the tick; state via
 * `deriveCaseConsultationState` (`'pending_reschedule'`). Copy from `UP_NEXT_COPY[workspaceType]`.
 */
export function resolveRescheduleNote(
  row: Pick<UpNextRowView, 'contextType' | 'status' | 'rescheduleProposalExpiresAt'>,
  now: Date,
  workspaceType: UpNextWorkspaceType
): string | null {
  if (row.contextType !== 'case' || row.rescheduleProposalExpiresAt === null) {
    return null;
  }
  const isLive = rescheduleProposalIsLive(
    { expiresAt: new Date(row.rescheduleProposalExpiresAt) },
    now
  );
  if (!isLive) {
    return null;
  }
  const state = deriveCaseConsultationState({
    status: row.status,
    outcome: null,
    hasLiveRescheduleProposal: true,
    clientSideEverPresent: null,
  });
  if (state !== 'pending_reschedule') {
    return null;
  }
  return UP_NEXT_COPY[workspaceType].rescheduleNote;
}
