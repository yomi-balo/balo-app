/**
 * BAL-498 — TZ=UTC required (memory `reference_web_tests_need_tz_utc`). Run with:
 *   TZ=UTC pnpm exec vitest run --project web src/lib/calendar/zoned-grid.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  zonedMinutesOfDay,
  addDaysToDayKey,
  weekStartDayKey,
  weeksBetweenDayKeys,
  formatZonedTimeRange,
  zonedMeetingSpan,
} from './zoned-grid';

describe('zonedMinutesOfDay', () => {
  it('reads wall-clock minutes in Australia/Melbourne', () => {
    // 2026-06-15T04:30:00Z = 14:30 AEST (UTC+10, no DST in June)
    expect(zonedMinutesOfDay('2026-06-15T04:30:00.000Z', 'Australia/Melbourne')).toBe(14 * 60 + 30);
  });

  it('reads wall-clock minutes in America/New_York', () => {
    // 2026-06-15T14:15:00Z = 10:15 EDT (UTC-4)
    expect(zonedMinutesOfDay('2026-06-15T14:15:00.000Z', 'America/New_York')).toBe(10 * 60 + 15);
  });

  it('reads wall-clock minutes in UTC', () => {
    expect(zonedMinutesOfDay('2026-06-15T09:05:00.000Z', 'UTC')).toBe(9 * 60 + 5);
  });
});

describe('DST — Australia/Sydney (acceptance criterion)', () => {
  it('spring forward 2026-10-04: a meeting from local 01:30 to 03:30 renders 120 wall-clock minutes tall, not the 60-minute elapsed duration', () => {
    // 2026-10-03T15:30:00Z = 2026-10-04 01:30 AEST (UTC+10, pre-transition)
    // 2026-10-03T16:30:00Z = 2026-10-04 03:30 AEDT (UTC+11, post-transition)
    // Real elapsed time: 60 minutes (02:00-02:59 AEST never occurred). Wall-clock span: 120 min.
    const start = '2026-10-03T15:30:00.000Z';
    const end = '2026-10-03T16:30:00.000Z';
    const span = zonedMeetingSpan(start, end, 'Australia/Sydney');

    expect(span.startMinutes).toBe(90); // 01:30
    expect(span.endMinutes).toBe(210); // 03:30
    const wallClockHeight = span.endMinutes - span.startMinutes;
    expect(wallClockHeight).toBe(120);

    // The regression this test exists to catch: height must NOT equal the elapsed real minutes.
    const elapsedRealMinutes = (new Date(end).getTime() - new Date(start).getTime()) / 60_000;
    expect(elapsedRealMinutes).toBe(60);
    expect(wallClockHeight).not.toBe(elapsedRealMinutes);
  });

  it('fall back 2026-04-05: two meetings a real hour apart both reading local 02:15 land on the same top and the same day key', () => {
    // First occurrence: 2026-04-05 02:15 AEDT (UTC+11) = 2026-04-04T15:15:00Z
    // Second occurrence: 2026-04-05 02:15 AEST (UTC+10) = 2026-04-04T16:15:00Z
    const firstOccurrence = '2026-04-04T15:15:00.000Z';
    const secondOccurrence = '2026-04-04T16:15:00.000Z';

    expect(zonedMinutesOfDay(firstOccurrence, 'Australia/Sydney')).toBe(2 * 60 + 15);
    expect(zonedMinutesOfDay(secondOccurrence, 'Australia/Sydney')).toBe(2 * 60 + 15);

    // A real hour apart, proven independently of the wall-clock reading above.
    const realMsApart = new Date(secondOccurrence).getTime() - new Date(firstOccurrence).getTime();
    expect(realMsApart).toBe(60 * 60 * 1000);
  });

  it('a normal (non-transition) day: 60 real minutes renders as exactly 60 wall-clock minutes (control)', () => {
    const start = '2026-06-15T04:00:00.000Z'; // 14:00 AEST
    const end = '2026-06-15T05:00:00.000Z'; // 15:00 AEST
    const span = zonedMeetingSpan(start, end, 'Australia/Sydney');
    expect(span.endMinutes - span.startMinutes).toBe(60);
  });
});

describe('addDaysToDayKey', () => {
  it('crosses a spring-forward date without shifting the calendar day', () => {
    expect(addDaysToDayKey('2026-10-03', 1)).toBe('2026-10-04');
  });

  it('crosses a month end', () => {
    expect(addDaysToDayKey('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('crosses a year end', () => {
    expect(addDaysToDayKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('is independent of the host process TZ', () => {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
    const originalTz = process.env.TZ;
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14 — transitions at local midnight for many zones
    try {
      expect(addDaysToDayKey('2026-04-05', 1)).toBe('2026-04-06');
      expect(addDaysToDayKey('2026-04-05', -1)).toBe('2026-04-04');
    } finally {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
      process.env.TZ = originalTz;
    }
  });
});

describe('weekStartDayKey', () => {
  it('anchors to Monday mid-week', () => {
    expect(weekStartDayKey('2026-08-27')).toBe('2026-08-24'); // Thursday -> Monday
  });

  it('a Monday maps to itself', () => {
    expect(weekStartDayKey('2026-08-24')).toBe('2026-08-24');
  });

  it('a Sunday maps back to the previous Monday, across a year boundary', () => {
    expect(weekStartDayKey('2027-01-03')).toBe('2026-12-28');
  });
});

describe('weeksBetweenDayKeys (BAL-512)', () => {
  it('is 0 for the same day key', () => {
    expect(weeksBetweenDayKeys('2026-08-24', '2026-08-24')).toBe(0);
  });

  it('normalises BOTH arguments to their Monday week start, so mid-week keys in the same week are 0', () => {
    expect(weeksBetweenDayKeys('2026-08-24', '2026-08-27')).toBe(0);
    expect(weeksBetweenDayKeys('2026-08-27', '2026-08-24')).toBe(0);
  });

  it('counts forward across whole weeks', () => {
    expect(weeksBetweenDayKeys('2026-08-24', '2026-09-07')).toBe(2);
  });

  it('counts backward with a negative sign', () => {
    expect(weeksBetweenDayKeys('2026-08-24', '2026-08-10')).toBe(-2);
  });

  it('normalises when NEITHER argument is a week start', () => {
    // '2026-08-27' (Thu, week of 08-24) -> '2026-09-09' (Wed, week of 09-07) === 2
    expect(weeksBetweenDayKeys('2026-08-27', '2026-09-09')).toBe(2);
  });

  it('treats Sunday as the END of its week, not the start (Monday-anchored)', () => {
    // '2026-08-30' (Sun, week of 08-24) -> '2026-08-31' (Mon) === 1
    expect(weeksBetweenDayKeys('2026-08-30', '2026-08-31')).toBe(1);
  });

  it('crosses a year boundary', () => {
    expect(weeksBetweenDayKeys('2026-12-28', '2027-01-04')).toBe(1);
  });

  // ── DST-crossing contract pins (the ticket asks for one; both Sydney transitions are pinned
  // because the module's existing DST block pins both). They PASS today and must keep passing.
  //
  // ⚠ WHAT THEY DO NOT DO: they cannot catch a rewrite of the helper onto a browser-local
  // `Date`. A transition shifts the range by one hour — 0.006 of a week — and the `Math.round`
  // in `weeksBetweenDayKeys` absorbs it long before it could change the answer, so no assertion
  // on the RETURN VALUE can see the difference. The real guarantee is the `Z` suffix on the two
  // parses in the helper; these cases pin the contract, not that implementation choice.
  it('spans Australia/Sydney SPRING FORWARD (2026-10-04) without losing an hour', () => {
    // '2026-09-28' (Mon) -> '2026-10-12' (Mon) === 2 — 14 calendar days containing a 23-hour day.
    expect(weeksBetweenDayKeys('2026-09-28', '2026-10-12')).toBe(2);
  });

  it('spans Australia/Sydney FALL BACK (2026-04-05) without gaining an hour', () => {
    // '2026-03-30' (Mon) -> '2026-04-13' (Mon) === 2 — 14 calendar days containing a 25-hour day.
    expect(weeksBetweenDayKeys('2026-03-30', '2026-04-13')).toBe(2);
  });

  it('is independent of the host process TZ', () => {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
    const originalTz = process.env.TZ;
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14 — transitions at local midnight for many zones
    try {
      expect(weeksBetweenDayKeys('2026-09-28', '2026-10-12')).toBe(2);
    } finally {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
      process.env.TZ = originalTz;
    }
  });

  it('throws rather than coercing an invalid day key, from either position', () => {
    expect(() => weeksBetweenDayKeys('nope', '2026-08-24')).toThrow(/invalid day key/);
    expect(() => weeksBetweenDayKeys('2026-08-24', 'nope')).toThrow(/invalid day key/);
  });
});

describe('formatZonedTimeRange', () => {
  it('formats a same-meridiem range once', () => {
    // 2:30 PM - 3:00 PM AEST
    const start = '2026-06-15T04:30:00.000Z';
    const end = '2026-06-15T05:00:00.000Z';
    expect(formatZonedTimeRange(start, end, 'Australia/Melbourne')).toBe('2:30 – 3:00 PM');
  });

  it('formats a range crossing local midnight with both meridiems', () => {
    // 11:45 PM AEST -> 12:15 AM AEST next day
    const start = '2026-06-15T13:45:00.000Z'; // 23:45 AEST
    const end = '2026-06-15T14:15:00.000Z'; // 00:15 AEST next day
    expect(formatZonedTimeRange(start, end, 'Australia/Melbourne')).toBe('11:45 PM – 12:15 AM');
  });
});

describe('zonedMeetingSpan', () => {
  it('clips at local midnight when the meeting crosses into the next day', () => {
    const start = '2026-06-15T13:45:00.000Z'; // 23:45 AEST
    const end = '2026-06-15T14:15:00.000Z'; // 00:15 AEST next day
    const span = zonedMeetingSpan(start, end, 'Australia/Melbourne');
    expect(span.crossesMidnight).toBe(true);
    expect(span.endMinutes).toBe(1440);
  });

  it('does not clip a same-day meeting', () => {
    const start = '2026-06-15T04:00:00.000Z';
    const end = '2026-06-15T05:00:00.000Z';
    const span = zonedMeetingSpan(start, end, 'Australia/Melbourne');
    expect(span.crossesMidnight).toBe(false);
  });
});
