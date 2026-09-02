import { describe, it, expect } from 'vitest';
import { CASE_JOIN_WINDOW_MINUTES, MEETING_OVERRUN_GRACE_MINUTES } from '@balo/shared/engagements';
import type { MeetingLifecycleStatus } from '@balo/shared/meetings';
import {
  calendarJoinAffordanceVisible,
  signedMinutesUntilCalendarStart,
  joinAffordanceTimingLabel,
  joinAffordanceAriaLabel,
  calendarMeetingTiming,
} from './join-window';

const SCHEDULED_START = new Date('2026-06-15T10:00:00.000Z');
const SCHEDULED_END = new Date('2026-06-15T10:30:00.000Z');

const ALL_STATUSES: readonly MeetingLifecycleStatus[] = [
  'scheduled',
  'waiting_for_participants',
  'in_progress',
  'ended',
  'cancelled',
];

const OPEN_STATUSES: readonly MeetingLifecycleStatus[] = [
  'scheduled',
  'waiting_for_participants',
  'in_progress',
];

const CLOSED_STATUSES: readonly MeetingLifecycleStatus[] = ['ended', 'cancelled'];

function minutesBeforeStart(minutes: number): Date {
  return new Date(SCHEDULED_START.getTime() - minutes * 60_000);
}

function minutesAfterEnd(minutes: number): Date {
  return new Date(SCHEDULED_END.getTime() + minutes * 60_000);
}

describe('calendarJoinAffordanceVisible', () => {
  it('is false at T-16min (just before the window opens)', () => {
    expect(
      calendarJoinAffordanceVisible(
        minutesBeforeStart(16),
        SCHEDULED_START,
        SCHEDULED_END,
        'scheduled'
      )
    ).toBe(false);
  });

  it('is true at T-15min (inclusive boundary, driven by the shared constant)', () => {
    expect(
      calendarJoinAffordanceVisible(
        minutesBeforeStart(CASE_JOIN_WINDOW_MINUTES),
        SCHEDULED_START,
        SCHEDULED_END,
        'scheduled'
      )
    ).toBe(true);
  });

  it('is true at the scheduled start', () => {
    expect(
      calendarJoinAffordanceVisible(SCHEDULED_START, SCHEDULED_START, SCHEDULED_END, 'scheduled')
    ).toBe(true);
  });

  it('is true mid-meeting', () => {
    const midMeeting = new Date(SCHEDULED_START.getTime() + 10 * 60_000);
    expect(
      calendarJoinAffordanceVisible(midMeeting, SCHEDULED_START, SCHEDULED_END, 'in_progress')
    ).toBe(true);
  });

  it('is true 1ms before the scheduled end', () => {
    const justBeforeEnd = new Date(SCHEDULED_END.getTime() - 1);
    expect(
      calendarJoinAffordanceVisible(justBeforeEnd, SCHEDULED_START, SCHEDULED_END, 'in_progress')
    ).toBe(true);
  });

  it('stays visible AT the scheduled end — a meeting that runs over keeps its Join (BAL-513)', () => {
    expect(
      calendarJoinAffordanceVisible(SCHEDULED_END, SCHEDULED_START, SCHEDULED_END, 'in_progress')
    ).toBe(true);
  });

  it('is false one hour after the scheduled end (60 min > 30 min grace)', () => {
    const longAfter = minutesAfterEnd(60);
    expect(
      calendarJoinAffordanceVisible(longAfter, SCHEDULED_START, SCHEDULED_END, 'in_progress')
    ).toBe(false);
  });

  it('reads CASE_JOIN_WINDOW_MINUTES rather than a hard-coded literal', () => {
    // If the shared constant ever changes, the computed boundary here must move with it —
    // proving this module has no second, hard-coded copy of "15".
    const boundary = minutesBeforeStart(CASE_JOIN_WINDOW_MINUTES);
    expect(
      calendarJoinAffordanceVisible(boundary, SCHEDULED_START, SCHEDULED_END, 'scheduled')
    ).toBe(true);
    const justOutside = new Date(boundary.getTime() - 60_000);
    expect(
      calendarJoinAffordanceVisible(justOutside, SCHEDULED_START, SCHEDULED_END, 'scheduled')
    ).toBe(false);
  });

  it('is true at scheduledEnd + grace − 1 minute', () => {
    const justInsideGrace = minutesAfterEnd(MEETING_OVERRUN_GRACE_MINUTES - 1);
    expect(
      calendarJoinAffordanceVisible(justInsideGrace, SCHEDULED_START, SCHEDULED_END, 'in_progress')
    ).toBe(true);
  });

  it('is false at scheduledEnd + grace (exclusive boundary)', () => {
    const atGraceBoundary = minutesAfterEnd(MEETING_OVERRUN_GRACE_MINUTES);
    expect(
      calendarJoinAffordanceVisible(atGraceBoundary, SCHEDULED_START, SCHEDULED_END, 'in_progress')
    ).toBe(false);
  });

  it('reads MEETING_OVERRUN_GRACE_MINUTES rather than a hard-coded literal', () => {
    const boundary = minutesAfterEnd(MEETING_OVERRUN_GRACE_MINUTES);
    const oneMinuteInside = new Date(boundary.getTime() - 60_000);
    expect(
      calendarJoinAffordanceVisible(oneMinuteInside, SCHEDULED_START, SCHEDULED_END, 'in_progress')
    ).toBe(true);
    expect(
      calendarJoinAffordanceVisible(boundary, SCHEDULED_START, SCHEDULED_END, 'in_progress')
    ).toBe(false);
  });

  it.each(CLOSED_STATUSES)('is false for a terminal status (%s), even mid-meeting', (status) => {
    const midMeeting = new Date(SCHEDULED_START.getTime() + 10 * 60_000);
    expect(calendarJoinAffordanceVisible(midMeeting, SCHEDULED_START, SCHEDULED_END, status)).toBe(
      false
    );
  });

  it.each(CLOSED_STATUSES)('is false for a terminal status (%s) at T-5', (status) => {
    expect(
      calendarJoinAffordanceVisible(minutesBeforeStart(5), SCHEDULED_START, SCHEDULED_END, status)
    ).toBe(false);
  });

  it.each(CLOSED_STATUSES)('is false for a terminal status (%s) at end + 5 min', (status) => {
    expect(
      calendarJoinAffordanceVisible(minutesAfterEnd(5), SCHEDULED_START, SCHEDULED_END, status)
    ).toBe(false);
  });

  // ⚠ Naming what is CLOSED is the point: `waiting_for_participants` must be OPEN.
  it.each(OPEN_STATUSES)('is true mid-meeting for an OPEN status (%s)', (status) => {
    const midMeeting = new Date(SCHEDULED_START.getTime() + 10 * 60_000);
    expect(calendarJoinAffordanceVisible(midMeeting, SCHEDULED_START, SCHEDULED_END, status)).toBe(
      true
    );
  });
});

describe('signedMinutesUntilCalendarStart — the UNFLOORED analytics contract (N7)', () => {
  it('is positive before the scheduled start', () => {
    expect(signedMinutesUntilCalendarStart(minutesBeforeStart(12), SCHEDULED_START)).toBe(12);
  });

  it('is 0 exactly at the scheduled start', () => {
    expect(signedMinutesUntilCalendarStart(SCHEDULED_START, SCHEDULED_START)).toBe(0);
  });

  it('is NEGATIVE once the meeting has begun — the exact contract calendar.ts documents', () => {
    const twelveMinutesLate = new Date(SCHEDULED_START.getTime() + 12 * 60_000);
    expect(signedMinutesUntilCalendarStart(twelveMinutesLate, SCHEDULED_START)).toBe(-12);
  });
});

describe('joinAffordanceTimingLabel', () => {
  it('"starting in 5 minutes" at T-5 min', () => {
    expect(joinAffordanceTimingLabel(minutesBeforeStart(5), SCHEDULED_START)).toBe(
      'starting in 5 minutes'
    );
  });

  it('uses the singular "minute" at exactly 1 minute out', () => {
    expect(joinAffordanceTimingLabel(minutesBeforeStart(1), SCHEDULED_START)).toBe(
      'starting in 1 minute'
    );
  });

  it('reads "starting now" exactly at the scheduled start', () => {
    expect(joinAffordanceTimingLabel(SCHEDULED_START, SCHEDULED_START)).toBe('starting now');
  });

  it('reads "starting now" at start + 20s — the `-0` boundary-minute pin', () => {
    const twentySecondsLate = new Date(SCHEDULED_START.getTime() + 20_000);
    expect(joinAffordanceTimingLabel(twentySecondsLate, SCHEDULED_START)).toBe('starting now');
  });

  it('reads "in progress" at start + 1 minute', () => {
    const oneMinuteLate = new Date(SCHEDULED_START.getTime() + 60_000);
    expect(joinAffordanceTimingLabel(oneMinuteLate, SCHEDULED_START)).toBe('in progress');
  });

  it('reads "in progress" at start + 30 minutes', () => {
    const thirtyMinutesLate = new Date(SCHEDULED_START.getTime() + 30 * 60_000);
    expect(joinAffordanceTimingLabel(thirtyMinutesLate, SCHEDULED_START)).toBe('in progress');
  });

  it('reads "in progress" at start + 90 minutes (past the end, inside grace) — replaces the 90-minute "starting now" lie', () => {
    const ninetyMinutesLate = new Date(SCHEDULED_START.getTime() + 90 * 60_000);
    expect(joinAffordanceTimingLabel(ninetyMinutesLate, SCHEDULED_START)).toBe('in progress');
  });
});

describe('joinAffordanceAriaLabel', () => {
  it('builds the full accessible name with a timing suffix', () => {
    expect(joinAffordanceAriaLabel('Northwind', 'starting in 5 minutes')).toBe(
      "Join Northwind's meeting, starting in 5 minutes"
    );
    expect(joinAffordanceAriaLabel('Northwind', 'in progress')).toBe(
      "Join Northwind's meeting, in progress"
    );
  });

  it('a null timing label yields the trailing-comma form (documented as unreachable behind the joinVisible guard)', () => {
    expect(joinAffordanceAriaLabel('Northwind', null)).toBe("Join Northwind's meeting, ");
  });
});

/**
 * BAL-511 D1 / BAL-513 D6 — the composition `WeekGrid` and `AgendaList` both compute so
 * `MeetingBlock` can take primitives and be `React.memo`'d. `joinTimingLabel` must be `null`
 * exactly when `joinVisible` is false, and `isPast`/`joinVisible` must never both be `true`.
 */
describe('calendarMeetingTiming', () => {
  it('outside the window, before start: joinVisible false, joinTimingLabel null', () => {
    const result = calendarMeetingTiming(
      minutesBeforeStart(20),
      SCHEDULED_START,
      SCHEDULED_END,
      'scheduled'
    );
    expect(result).toEqual({ isPast: false, joinVisible: false, joinTimingLabel: null });
  });

  it('inside the window (5 min out): joinVisible true, labelled', () => {
    const result = calendarMeetingTiming(
      minutesBeforeStart(5),
      SCHEDULED_START,
      SCHEDULED_END,
      'scheduled'
    );
    expect(result.joinVisible).toBe(true);
    expect(result.joinTimingLabel).toBe('starting in 5 minutes');
    expect(result.isPast).toBe(false);
  });

  it('in progress (past start, before end): joinVisible true, "in progress", not past', () => {
    const midMeeting = new Date(SCHEDULED_START.getTime() + 10 * 60_000);
    const result = calendarMeetingTiming(midMeeting, SCHEDULED_START, SCHEDULED_END, 'in_progress');
    expect(result.joinVisible).toBe(true);
    expect(result.joinTimingLabel).toBe('in progress');
    expect(result.isPast).toBe(false);
  });

  it("end + 10 min, still 'scheduled' status: an overrun is neither muted nor un-joinable (D6)", () => {
    const result = calendarMeetingTiming(
      minutesAfterEnd(10),
      SCHEDULED_START,
      SCHEDULED_END,
      'scheduled'
    );
    expect(result).toEqual({ isPast: false, joinVisible: true, joinTimingLabel: 'in progress' });
  });

  it('end + grace − 1 min: still joinable, not past (AC4)', () => {
    const result = calendarMeetingTiming(
      minutesAfterEnd(MEETING_OVERRUN_GRACE_MINUTES - 1),
      SCHEDULED_START,
      SCHEDULED_END,
      'in_progress'
    );
    expect(result.isPast).toBe(false);
    expect(result.joinVisible).toBe(true);
  });

  it('end + grace: past, not joinable (AC4)', () => {
    const result = calendarMeetingTiming(
      minutesAfterEnd(MEETING_OVERRUN_GRACE_MINUTES),
      SCHEDULED_START,
      SCHEDULED_END,
      'in_progress'
    );
    expect(result).toEqual({ isPast: true, joinVisible: false, joinTimingLabel: null });
  });

  it('end + 1h: past, not joinable', () => {
    const longAfter = minutesAfterEnd(60);
    const result = calendarMeetingTiming(longAfter, SCHEDULED_START, SCHEDULED_END, 'in_progress');
    expect(result).toEqual({ isPast: true, joinVisible: false, joinTimingLabel: null });
  });

  it("mid-meeting but 'ended': terminal status wins over the clock", () => {
    const midMeeting = new Date(SCHEDULED_START.getTime() + 10 * 60_000);
    const result = calendarMeetingTiming(midMeeting, SCHEDULED_START, SCHEDULED_END, 'ended');
    expect(result).toEqual({ isPast: true, joinVisible: false, joinTimingLabel: null });
  });

  it('the non-tick pin: a meeting 3 hours out carries a null label at now AND at now + 60s', () => {
    const threeHoursOut = new Date(SCHEDULED_START.getTime() - 3 * 60 * 60_000);
    const oneTickLater = new Date(threeHoursOut.getTime() + 60_000);
    expect(
      calendarMeetingTiming(threeHoursOut, SCHEDULED_START, SCHEDULED_END, 'scheduled')
        .joinTimingLabel
    ).toBe(null);
    expect(
      calendarMeetingTiming(oneTickLater, SCHEDULED_START, SCHEDULED_END, 'scheduled')
        .joinTimingLabel
    ).toBe(null);
  });

  const INSTANTS: readonly { readonly label: string; readonly now: Date }[] = [
    { label: 'T-20', now: minutesBeforeStart(20) },
    { label: 'T-5', now: minutesBeforeStart(5) },
    { label: 'start', now: SCHEDULED_START },
    { label: 'mid', now: new Date(SCHEDULED_START.getTime() + 10 * 60_000) },
    { label: 'end', now: SCHEDULED_END },
    { label: 'end+10', now: minutesAfterEnd(10) },
    { label: 'end+grace', now: minutesAfterEnd(MEETING_OVERRUN_GRACE_MINUTES) },
    { label: 'end+1h', now: minutesAfterEnd(60) },
  ];

  it.each(
    INSTANTS.flatMap(({ label, now }) => ALL_STATUSES.map((status) => ({ label, now, status })))
  )('isPast and joinVisible are never both true — $label / $status', ({ now, status }) => {
    const result = calendarMeetingTiming(now, SCHEDULED_START, SCHEDULED_END, status);
    expect(result.isPast && result.joinVisible).toBe(false);
  });
});
