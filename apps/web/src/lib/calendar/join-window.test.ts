import { describe, it, expect } from 'vitest';
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import {
  calendarJoinAffordanceVisible,
  minutesUntilCalendarStart,
  signedMinutesUntilCalendarStart,
  joinAffordanceTimingLabel,
} from './join-window';

const SCHEDULED_START = new Date('2026-06-15T10:00:00.000Z');
const SCHEDULED_END = new Date('2026-06-15T10:30:00.000Z');

function minutesBeforeStart(minutes: number): Date {
  return new Date(SCHEDULED_START.getTime() - minutes * 60_000);
}

describe('calendarJoinAffordanceVisible', () => {
  it('is false at T-16min (just before the window opens)', () => {
    expect(
      calendarJoinAffordanceVisible(minutesBeforeStart(16), SCHEDULED_START, SCHEDULED_END)
    ).toBe(false);
  });

  it('is true at T-15min (inclusive boundary, driven by the shared constant)', () => {
    expect(
      calendarJoinAffordanceVisible(
        minutesBeforeStart(CASE_JOIN_WINDOW_MINUTES),
        SCHEDULED_START,
        SCHEDULED_END
      )
    ).toBe(true);
  });

  it('is true at the scheduled start', () => {
    expect(calendarJoinAffordanceVisible(SCHEDULED_START, SCHEDULED_START, SCHEDULED_END)).toBe(
      true
    );
  });

  it('is true mid-meeting', () => {
    const midMeeting = new Date(SCHEDULED_START.getTime() + 10 * 60_000);
    expect(calendarJoinAffordanceVisible(midMeeting, SCHEDULED_START, SCHEDULED_END)).toBe(true);
  });

  it('is true 1ms before the scheduled end', () => {
    const justBeforeEnd = new Date(SCHEDULED_END.getTime() - 1);
    expect(calendarJoinAffordanceVisible(justBeforeEnd, SCHEDULED_START, SCHEDULED_END)).toBe(true);
  });

  it('is false at the scheduled end (exclusive)', () => {
    expect(calendarJoinAffordanceVisible(SCHEDULED_END, SCHEDULED_START, SCHEDULED_END)).toBe(
      false
    );
  });

  it('is false one hour after the scheduled end', () => {
    const longAfter = new Date(SCHEDULED_END.getTime() + 60 * 60_000);
    expect(calendarJoinAffordanceVisible(longAfter, SCHEDULED_START, SCHEDULED_END)).toBe(false);
  });

  it('reads CASE_JOIN_WINDOW_MINUTES rather than a hard-coded literal', () => {
    // If the shared constant ever changes, the computed boundary here must move with it —
    // proving this module has no second, hard-coded copy of "15".
    const boundary = minutesBeforeStart(CASE_JOIN_WINDOW_MINUTES);
    expect(calendarJoinAffordanceVisible(boundary, SCHEDULED_START, SCHEDULED_END)).toBe(true);
    const justOutside = new Date(boundary.getTime() - 60_000);
    expect(calendarJoinAffordanceVisible(justOutside, SCHEDULED_START, SCHEDULED_END)).toBe(false);
  });
});

describe('signedMinutesUntilCalendarStart — the UNFLOORED analytics contract (N7)', () => {
  it('is positive before the scheduled start', () => {
    expect(signedMinutesUntilCalendarStart(minutesBeforeStart(12), SCHEDULED_START)).toBe(12);
  });

  it('is 0 exactly at the scheduled start', () => {
    expect(signedMinutesUntilCalendarStart(SCHEDULED_START, SCHEDULED_START)).toBe(0);
  });

  it('is NEGATIVE once the meeting has begun — the exact contract calendar.ts documents, and the one minutesUntilCalendarStart must NOT satisfy', () => {
    const twelveMinutesLate = new Date(SCHEDULED_START.getTime() + 12 * 60_000);
    expect(signedMinutesUntilCalendarStart(twelveMinutesLate, SCHEDULED_START)).toBe(-12);
    // The floored sibling collapses this to 0 — proving they are genuinely different helpers,
    // not the same computation under two names.
    expect(minutesUntilCalendarStart(twelveMinutesLate, SCHEDULED_START)).toBe(0);
  });
});

describe('minutesUntilCalendarStart — floored, label-only (N7)', () => {
  it('is floored at 0 once the meeting has started, never negative', () => {
    const oneMinuteLate = new Date(SCHEDULED_START.getTime() + 60_000);
    expect(minutesUntilCalendarStart(oneMinuteLate, SCHEDULED_START)).toBe(0);
  });

  it('matches the signed value before the start', () => {
    expect(minutesUntilCalendarStart(minutesBeforeStart(5), SCHEDULED_START)).toBe(5);
  });
});

describe('joinAffordanceTimingLabel', () => {
  it('reads "starting now" once the meeting has started', () => {
    expect(joinAffordanceTimingLabel(SCHEDULED_START, SCHEDULED_START)).toBe('starting now');
  });

  it('uses the singular "minute" at exactly 1 minute out', () => {
    expect(joinAffordanceTimingLabel(minutesBeforeStart(1), SCHEDULED_START)).toBe(
      'starting in 1 minute'
    );
  });

  it('uses the plural "minutes" otherwise', () => {
    expect(joinAffordanceTimingLabel(minutesBeforeStart(5), SCHEDULED_START)).toBe(
      'starting in 5 minutes'
    );
  });
});
