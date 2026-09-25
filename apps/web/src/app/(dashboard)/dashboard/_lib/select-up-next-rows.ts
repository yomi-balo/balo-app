import { DASHBOARD_UP_NEXT_MEETING_TYPES } from '@balo/analytics/events';
import type { MeetingContextTypeWithHolder, MeetingLifecycleStatus } from '@balo/shared/meetings';
import { calendarMeetingTiming } from '@/lib/calendar/join-window';
import type { UpNextMeetingType } from './up-next-view-types';

/** BAL-566 — up to four rows, soonest first. */
export const UP_NEXT_ROW_LIMIT = 4;
/** The overlap lookback: a meeting that started up to 2h ago and is still running is listed. */
export const UP_NEXT_LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** The forward horizon, in days. */
export const UP_NEXT_HORIZON_DAYS = 14;

export interface UpNextCandidate {
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly status: MeetingLifecycleStatus;
  readonly contextType: MeetingContextTypeWithHolder;
  readonly contextId: string | null;
  readonly projectRequestId: string | null;
  readonly owningRowFound: boolean;
  /** BAL-581 — the repository's SQL-twin readiness boolean. */
  readonly roomReady: boolean;
}

/** `now − 2h .. now + 14d` — the ONE window both the company and expert reads use. */
export function upNextWindow(now: Date): { rangeStart: Date; rangeEnd: Date } {
  return {
    rangeStart: new Date(now.getTime() - UP_NEXT_LOOKBACK_MS),
    rangeEnd: new Date(now.getTime() + UP_NEXT_HORIZON_DAYS * 24 * 60 * 60 * 1000),
  };
}

/** Narrows to the four context types Up next lists — package/retainer sessions are never listed. */
export function isUpNextMeetingType(type: MeetingContextTypeWithHolder): type is UpNextMeetingType {
  return (DASHBOARD_UP_NEXT_MEETING_TYPES as readonly string[]).includes(type);
}

/**
 * BAL-566 (D1/D2) — keeps the four Up next context types; drops every row whose join window has
 * closed OR whose status is terminal. `calendarMeetingTiming(...).isPast` is the ONE definition
 * (it already includes `meetingIsClosedToJoin`, so `ended` from the expert calendar read drops
 * here too). Preserves input order (both sources are `scheduled_start ASC, id ASC`) — no sort.
 * Slices to `limit`.
 */
export function selectUpNextRows<T extends UpNextCandidate>(
  rows: readonly T[],
  now: Date,
  limit: number = UP_NEXT_ROW_LIMIT
): Array<T & { readonly contextType: UpNextMeetingType }> {
  const kept: Array<T & { readonly contextType: UpNextMeetingType }> = [];
  for (const row of rows) {
    if (!isUpNextMeetingType(row.contextType)) continue;
    const timing = calendarMeetingTiming(
      now,
      row.scheduledStart,
      row.scheduledEnd,
      row.status,
      row.roomReady
    );
    if (timing.isPast) continue;
    kept.push({ ...row, contextType: row.contextType });
    if (kept.length >= limit) break;
  }
  return kept;
}
