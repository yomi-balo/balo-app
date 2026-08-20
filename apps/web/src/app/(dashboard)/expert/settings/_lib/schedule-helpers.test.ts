import { describe, it, expect } from 'vitest';
import type { ScheduleRule } from '../_types/schedule';
import {
  BUFFER_OPTIONS,
  DEFAULT_BOOKING_SETTINGS,
  NOTICE_OPTIONS,
  TIME_OPTIONS,
  buildEndOptions,
  changeRangeInWeek,
  conflictInlineMessages,
  copyDayRangesInWeek,
  countEnabledDays,
  createDefaultWeek,
  createEmptyWeek,
  dayHasOtherOvernightRange,
  findScheduleConflict,
  findWeekGapMatch,
  hasLateWindow,
  hasOvernightWindow,
  removeRangeFromWeek,
  formatHhmm,
  hasSplitDays,
  hhmmToMinutes,
  isOvernightRange,
  minutesToHhmm,
  newRangeId,
  nextRangeDefault,
  rulesToWeek,
  summarizeWeek,
  validateWeek,
  weekToRules,
  type TimeRange,
  type WeekState,
} from './schedule-helpers';

describe('time conversions', () => {
  it('round-trips minutes ↔ HH:mm', () => {
    expect(hhmmToMinutes('09:00')).toBe(540);
    expect(hhmmToMinutes('17:45')).toBe(1065);
    expect(minutesToHhmm(540)).toBe('09:00');
    expect(minutesToHhmm(1065)).toBe('17:45');
  });

  it('formats 12-hour labels', () => {
    expect(formatHhmm('00:00')).toBe('12:00 AM');
    expect(formatHhmm('09:00')).toBe('9:00 AM');
    expect(formatHhmm('12:00')).toBe('12:00 PM');
    expect(formatHhmm('13:30')).toBe('1:30 PM');
    expect(formatHhmm('23:45')).toBe('11:45 PM');
  });
});

describe('TIME_OPTIONS', () => {
  it('covers every 15-minute slot from 00:00 to 23:45', () => {
    expect(TIME_OPTIONS).toHaveLength(96);
    expect(TIME_OPTIONS[0]).toEqual({ value: '00:00', label: '12:00 AM' });
    expect(TIME_OPTIONS.at(-1)).toEqual({ value: '23:45', label: '11:45 PM' });
  });
});

describe('start options after BAL-415', () => {
  it('the start picker uses the full TIME_OPTIONS set (23:45 is now a valid start)', () => {
    expect(TIME_OPTIONS).toHaveLength(96);
    expect(TIME_OPTIONS.some((o) => o.value === '23:45')).toBe(true);
  });

  it('a 23:45 start yields 95 wrapped end options, all suffixed (next day)', () => {
    const options = buildEndOptions({ start: '23:45', end: '00:00' }, true);
    expect(options).toHaveLength(95);
    expect(options.every((o) => o.label.endsWith('(next day)'))).toBe(true);
  });
});

describe('isOvernightRange', () => {
  it('is false for a normal same-day range', () => {
    expect(isOvernightRange({ start: '09:00', end: '17:00' })).toBe(false);
  });

  it('is true when the end is earlier than the start', () => {
    expect(isOvernightRange({ start: '22:00', end: '02:00' })).toBe(true);
  });

  it('is true for a midnight end (00:00), by definition', () => {
    expect(isOvernightRange({ start: '09:00', end: '00:00' })).toBe(true);
  });

  it('is false when start equals end (a different, forbidden error)', () => {
    expect(isOvernightRange({ start: '09:00', end: '09:00' })).toBe(false);
  });
});

describe('dayHasOtherOvernightRange', () => {
  it('is true when a sibling range crosses midnight', () => {
    const day = {
      enabled: true,
      ranges: [
        { id: 'r1', start: '09:00', end: '17:00' },
        { id: 'r2', start: '22:00', end: '02:00' },
      ],
    };
    expect(dayHasOtherOvernightRange(day, 'r1')).toBe(true);
  });

  it('is false for the crossing range itself', () => {
    const day = { enabled: true, ranges: [{ id: 'r2', start: '22:00', end: '02:00' }] };
    expect(dayHasOtherOvernightRange(day, 'r2')).toBe(false);
  });
});

describe('buildEndOptions', () => {
  const range: TimeRange = { id: 'r1', start: '10:00', end: '11:00' };

  it('never offers the range own start', () => {
    expect(buildEndOptions(range, true).some((o) => o.value === '10:00')).toBe(false);
  });

  it('returns 95 options with allowOvernight, same-day first and unsuffixed', () => {
    const options = buildEndOptions(range, true);
    expect(options).toHaveLength(95);
    expect(options[0]).toEqual({ value: '10:15', label: '10:15 AM' });
    expect(options.every((o) => o.value > '10:00' || o.label.endsWith('(next day)'))).toBe(true);
  });

  it('the wrapped half is strictly less than start and all suffixed', () => {
    const options = buildEndOptions(range, true);
    const wrapped = options.filter((o) => o.value < range.start);
    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped.every((o) => o.label.endsWith('(next day)'))).toBe(true);
  });

  it('drops the wrapped half when allowOvernight is false', () => {
    const options = buildEndOptions(range, false);
    expect(options.every((o) => o.value > range.start)).toBe(true);
  });

  it('keeps the wrapped half when allowOvernight is false but the range itself already crosses', () => {
    const crossing: TimeRange = { id: 'r1', start: '22:00', end: '02:00' };
    const options = buildEndOptions(crossing, false);
    expect(options.some((o) => o.value === '02:00')).toBe(true);
  });
});

describe('option sets', () => {
  it('matches the exact design-reference option sets (no booking-window control)', () => {
    expect(BUFFER_OPTIONS.map((o) => o.value)).toEqual([0, 5, 10, 15, 30]);
    expect(NOTICE_OPTIONS.map((o) => o.value)).toEqual([0, 60, 120, 240, 720, 1440, 2880]);
  });

  it('defaults every booking rule to 0 (buffers + notice only)', () => {
    expect(DEFAULT_BOOKING_SETTINGS).toEqual({
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minimumNoticeMinutes: 0,
    });
  });
});

describe('createDefaultWeek', () => {
  it('enables Mon–Fri 09:00–17:00 and turns Sat/Sun off', () => {
    const week = createDefaultWeek();
    expect(week).toHaveLength(7);
    for (let i = 0; i < 5; i++) {
      expect(week[i]?.enabled).toBe(true);
      expect(week[i]?.ranges).toHaveLength(1);
      expect(week[i]?.ranges[0]?.start).toBe('09:00');
      expect(week[i]?.ranges[0]?.end).toBe('17:00');
    }
    expect(week[5]?.enabled).toBe(false);
    expect(week[6]?.enabled).toBe(false);
  });
});

describe('weekToRules ↔ rulesToWeek (Mon-first display ↔ 0=Sun dayOfWeek)', () => {
  it('serializes the default week to Monday=1 … Friday=5', () => {
    const rules = weekToRules(createDefaultWeek());
    expect(rules).toHaveLength(5);
    expect(rules.map((r) => r.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(rules.every((r) => r.startTime === '09:00' && r.endTime === '17:00')).toBe(true);
  });

  it('round-trips rules back into the correct display slots', () => {
    const week = rulesToWeek([
      { dayOfWeek: 0, startTime: '10:00', endTime: '12:00' }, // Sunday → index 6
      { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }, // Monday → index 0
    ]);
    expect(week[0]?.enabled).toBe(true);
    expect(week[6]?.enabled).toBe(true);
    expect(week[1]?.enabled).toBe(false);
    expect(week[6]?.ranges[0]?.start).toBe('10:00');
  });

  it('round-trips a crossing rule as ONE editor row, not split into two', () => {
    const rules: ScheduleRule[] = [{ dayOfWeek: 1, startTime: '21:00', endTime: '01:00' }];
    const week = rulesToWeek(rules);
    expect(week[0]?.enabled).toBe(true);
    expect(week[0]?.ranges).toHaveLength(1);
    expect(week[0]?.ranges[0]).toMatchObject({ start: '21:00', end: '01:00' });
    expect(weekToRules(week)).toEqual(rules);
  });
});

describe('derived metrics', () => {
  it('counts enabled days and detects split days', () => {
    const week = createDefaultWeek();
    expect(countEnabledDays(week)).toBe(5);
    expect(hasSplitDays(week)).toBe(false);

    week[0]?.ranges.push({ id: newRangeId(), start: '18:00', end: '20:00' });
    expect(hasSplitDays(week)).toBe(true);
  });
});

describe('validateWeek', () => {
  it('returns null for a valid week', () => {
    expect(validateWeek(createDefaultWeek())).toBeNull();
  });

  it('flags an enabled day with no ranges', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) monday.enabled = true;
    expect(validateWeek(week)).toMatch(/Monday/);
  });

  it('flags overlapping ranges on a day', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = true;
      monday.ranges = [
        { id: newRangeId(), start: '09:00', end: '12:00' },
        { id: newRangeId(), start: '11:00', end: '14:00' },
      ];
    }
    expect(validateWeek(week)).toMatch(/overlap/i);
  });

  it('accepts a range that crosses midnight', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = true;
      monday.ranges = [{ id: newRangeId(), start: '17:00', end: '09:00' }];
    }
    expect(validateWeek(week)).toBeNull();
  });

  it('flags start === end with a dedicated message', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = true;
      monday.ranges = [{ id: newRangeId(), start: '09:00', end: '09:00' }];
    }
    expect(validateWeek(week)).toMatch(/different start and end/);
  });
});

describe('summarizeWeek', () => {
  it('groups consecutive identical days into a single segment', () => {
    expect(summarizeWeek(createDefaultWeek())).toEqual([
      { days: 'Mon–Fri', hours: '9:00 AM – 5:00 PM' },
    ]);
  });

  it('splits a day with different hours into its own segment', () => {
    const week = createDefaultWeek();
    const wed = week[2];
    if (wed) wed.ranges = [{ id: newRangeId(), start: '10:00', end: '14:00' }];
    const segments = summarizeWeek(week);
    expect(segments).toEqual([
      { days: 'Mon–Tue', hours: '9:00 AM – 5:00 PM' },
      { days: 'Wed', hours: '10:00 AM – 2:00 PM' },
      { days: 'Thu–Fri', hours: '9:00 AM – 5:00 PM' },
    ]);
  });

  it('renders a crossing range with the (next day) suffix', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = true;
      monday.ranges = [{ id: newRangeId(), start: '21:00', end: '01:00' }];
    }
    expect(summarizeWeek(week)).toEqual([{ days: 'Mon', hours: '9:00 PM – 1:00 AM (next day)' }]);
  });

  it('compresses five identical crossing weeknights into one Mon–Fri segment', () => {
    const week = createEmptyWeek();
    for (let i = 0; i < 5; i++) {
      const day = week[i];
      if (day) {
        day.enabled = true;
        day.ranges = [{ id: newRangeId(), start: '21:00', end: '01:00' }];
      }
    }
    expect(summarizeWeek(week)).toEqual([
      { days: 'Mon–Fri', hours: '9:00 PM – 1:00 AM (next day)' },
    ]);
  });
});

describe('week mutations (extracted pure helpers)', () => {
  const weekWith = (dayIndex: number, ranges: { start: string; end: string }[]): WeekState => {
    const week = createEmptyWeek();
    const day = week[dayIndex];
    if (day) {
      day.enabled = true;
      day.ranges = ranges.map((r) => ({ id: newRangeId(), start: r.start, end: r.end }));
    }
    return week;
  };
  const firstRangeId = (week: WeekState): string => week[0]?.ranges[0]?.id ?? '';

  it('changeRangeInWeek leaves the end alone when the start moves past it (range becomes crossing)', () => {
    const week = weekWith(0, [{ start: '09:00', end: '10:00' }]);
    const next = changeRangeInWeek(week, 0, firstRangeId(week), 'start', '10:30');
    expect(next[0]?.ranges[0]).toMatchObject({ start: '10:30', end: '10:00' });
  });

  it('changeRangeInWeek bumps the end one step when the start lands exactly on it', () => {
    const week = weekWith(0, [{ start: '09:00', end: '10:00' }]);
    const next = changeRangeInWeek(week, 0, firstRangeId(week), 'start', '10:00');
    expect(next[0]?.ranges[0]).toMatchObject({ start: '10:00', end: '10:15' });
  });

  it('changeRangeInWeek wraps the bump 23:45 → 00:00 (the clamp bug)', () => {
    const week = weekWith(0, [{ start: '23:45', end: '23:45' }]);
    const next = changeRangeInWeek(week, 0, firstRangeId(week), 'start', '23:45');
    expect(next[0]?.ranges[0]).toMatchObject({ start: '23:45', end: '00:00' });
  });

  it('changeRangeInWeek sets the end directly for the end field', () => {
    const week = weekWith(0, [{ start: '09:00', end: '10:00' }]);
    const next = changeRangeInWeek(week, 0, firstRangeId(week), 'end', '11:00');
    expect(next[0]?.ranges[0]).toMatchObject({ start: '09:00', end: '11:00' });
  });

  it('removeRangeFromWeek removes the range and disables an emptied day', () => {
    const week = weekWith(0, [{ start: '09:00', end: '10:00' }]);
    const next = removeRangeFromWeek(week, 0, firstRangeId(week));
    expect(next[0]?.ranges).toHaveLength(0);
    expect(next[0]?.enabled).toBe(false);
  });

  it('copyDayRangesInWeek copies ranges with fresh ids and enables the targets', () => {
    const week = weekWith(0, [{ start: '09:00', end: '17:00' }]);
    const next = copyDayRangesInWeek(week, 0, [1, 2]);
    expect(next[1]?.enabled).toBe(true);
    expect(next[1]?.ranges[0]).toMatchObject({ start: '09:00', end: '17:00' });
    expect(next[1]?.ranges[0]?.id).not.toBe(firstRangeId(week));
    expect(next[2]?.enabled).toBe(true);
  });

  it('copyDayRangesInWeek is a no-op for an out-of-range source index', () => {
    const week = weekWith(0, [{ start: '09:00', end: '17:00' }]);
    expect(copyDayRangesInWeek(week, 99, [1])).toBe(week);
  });
});

describe('findWeekGapMatch (pure, Intl-free)', () => {
  // Sunday 02:00–03:00 gap (the extracted overlap test takes a precomputed gap).
  const SUNDAY_GAP = {
    dateISO: '2026-10-04',
    dayOfWeek: 0,
    gapStartMinutes: 120,
    gapEndMinutes: 180,
  };

  const sundayWeek = (start: string, end: string): WeekState => {
    const week = createEmptyWeek();
    const sunday = week[6];
    if (sunday) {
      sunday.enabled = true;
      sunday.ranges = [{ id: newRangeId(), start, end }];
    }
    return week;
  };

  it('matches a non-crossing range on the gap weekday (front-half, not a tail)', () => {
    const match = findWeekGapMatch(sundayWeek('01:00', '04:00'), SUNDAY_GAP);
    expect(match).toEqual({ isOvernightTail: false, sourceDayIndex: 6 });
  });

  it('is null when the range is entirely outside the gap window', () => {
    expect(findWeekGapMatch(sundayWeek('05:00', '09:00'), SUNDAY_GAP)).toBeNull();
  });

  it('is null when no enabled day falls on the gap weekday', () => {
    // Mon–Fri default week; the gap is on Sunday.
    expect(findWeekGapMatch(createDefaultWeek(), SUNDAY_GAP)).toBeNull();
  });

  it('matches the front half of a crossing range authored on the gap day', () => {
    // 01:40 → 00:50 next day; own-day extent is [100, 1440), which contains the gap.
    const week = sundayWeek('01:40', '00:50');
    const match = findWeekGapMatch(week, SUNDAY_GAP);
    expect(match).toEqual({ isOvernightTail: false, sourceDayIndex: 6 });
  });

  it('matches the TAIL of a crossing range authored the previous day', () => {
    // Saturday 22:00 → 04:00; tail [0, 240) on Sunday contains the Sunday gap.
    const week = createEmptyWeek();
    const saturday = week[5];
    if (saturday) {
      saturday.enabled = true;
      saturday.ranges = [{ id: newRangeId(), start: '22:00', end: '04:00' }];
    }
    const match = findWeekGapMatch(week, SUNDAY_GAP);
    expect(match).toEqual({ isOvernightTail: true, sourceDayIndex: 5 });
  });

  it('is null when the next-day end is 00:00 (zero-length tail)', () => {
    const week = createEmptyWeek();
    const saturday = week[5];
    if (saturday) {
      saturday.enabled = true;
      saturday.ranges = [{ id: newRangeId(), start: '09:00', end: '00:00' }];
    }
    expect(findWeekGapMatch(week, SUNDAY_GAP)).toBeNull();
  });
});

describe('nextRangeDefault', () => {
  it('returns the seed default when there is nothing yet', () => {
    expect(nextRangeDefault([])).toMatchObject({ start: '09:00', end: '17:00' });
  });

  it('after 09:00–17:00, defaults to 18:00–19:00', () => {
    expect(nextRangeDefault([{ id: 'a', start: '09:00', end: '17:00' }])).toMatchObject({
      start: '18:00',
      end: '19:00',
    });
  });

  it('after 09:00–21:00, defaults to 22:00–23:00', () => {
    expect(nextRangeDefault([{ id: 'a', start: '09:00', end: '21:00' }])).toMatchObject({
      start: '22:00',
      end: '23:00',
    });
  });

  it('after 09:00–23:00, wraps to 23:45–00:45 instead of the old degenerate 23:45–23:45', () => {
    expect(nextRangeDefault([{ id: 'a', start: '09:00', end: '23:00' }])).toMatchObject({
      start: '23:45',
      end: '00:45',
    });
  });

  it('after 09:00–22:30, wraps to 23:30–00:30', () => {
    expect(nextRangeDefault([{ id: 'a', start: '09:00', end: '22:30' }])).toMatchObject({
      start: '23:30',
      end: '00:30',
    });
  });

  it('anchors off the wrapped end of an existing crossing range (22:00→02:00 ⇒ 03:00–04:00)', () => {
    expect(nextRangeDefault([{ id: 'a', start: '22:00', end: '02:00' }])).toMatchObject({
      start: '03:00',
      end: '04:00',
    });
  });

  it('anchors off a zero-length tail (09:00→00:00 ⇒ 01:00–02:00)', () => {
    expect(nextRangeDefault([{ id: 'a', start: '09:00', end: '00:00' }])).toMatchObject({
      start: '01:00',
      end: '02:00',
    });
  });

  it('returns null when the day is genuinely exhausted (a crossing range plus a same-day range covering every other minute)', () => {
    const existing: TimeRange[] = [
      { id: 'b', start: '00:00', end: '20:00' },
      { id: 'a', start: '20:00', end: '04:00' },
    ];
    expect(nextRangeDefault(existing)).toBeNull();
  });
});

describe('findScheduleConflict', () => {
  const weekWith = (days: Record<number, { start: string; end: string }[]>): WeekState => {
    const week = createEmptyWeek();
    for (const [dayIndex, ranges] of Object.entries(days)) {
      const day = week[Number(dayIndex)];
      if (day) {
        day.enabled = true;
        day.ranges = ranges.map((r) => ({ id: newRangeId(), start: r.start, end: r.end }));
      }
    }
    return week;
  };

  it('is null for the default week', () => {
    expect(findScheduleConflict(createDefaultWeek())).toBeNull();
  });

  it('is null for a clean crossing week (Mon 22:00→02:00, Tue 09:00–17:00)', () => {
    const week = weekWith({
      0: [{ start: '22:00', end: '02:00' }],
      1: [{ start: '09:00', end: '17:00' }],
    });
    expect(findScheduleConflict(week)).toBeNull();
  });

  it('detects a cross-day-overlap Mon→Tue', () => {
    const week = weekWith({
      0: [{ start: '22:00', end: '02:00' }],
      1: [{ start: '01:00', end: '09:00' }],
    });
    const conflict = findScheduleConflict(week);
    expect(conflict?.kind).toBe('cross-day-overlap');
    expect(conflict?.dayIndex).toBe(0);
    expect(conflict?.conflictDayIndex).toBe(1);
    expect(conflict?.message).toMatch(/Monday/);
    expect(conflict?.message).toMatch(/Tuesday/);
    expect(conflict?.message).toMatch(/10:00 PM – 2:00 AM/);
    expect(conflict?.message).toMatch(/1:00 AM – 9:00 AM/);
  });

  it('detects the Sunday→Monday wrap', () => {
    const week = weekWith({
      6: [{ start: '23:00', end: '03:00' }],
      0: [{ start: '01:30', end: '08:00' }],
    });
    const conflict = findScheduleConflict(week);
    expect(conflict?.kind).toBe('cross-day-overlap');
    expect(conflict?.dayIndex).toBe(6);
    expect(conflict?.conflictDayIndex).toBe(0);
  });

  it('detects two-overnight ranges on one day', () => {
    const week = weekWith({
      0: [
        { start: '20:00', end: '01:00' },
        { start: '21:00', end: '02:00' },
      ],
    });
    const conflict = findScheduleConflict(week);
    expect(conflict?.kind).toBe('two-overnight');
    expect(conflict?.message).toMatch(/only have one overnight range/);
  });

  it('detects a same-day-overlap where a crossing range swallows a same-day sibling', () => {
    const week = weekWith({
      0: [
        { start: '09:00', end: '00:00' },
        { start: '14:00', end: '15:00' },
      ],
    });
    const conflict = findScheduleConflict(week);
    expect(conflict?.kind).toBe('same-day-overlap');
  });

  it('is null for a 09:00→00:00 range against a next-day 00:15–09:00 range (zero-length tail)', () => {
    const week = weekWith({
      0: [{ start: '09:00', end: '00:00' }],
      1: [{ start: '00:15', end: '09:00' }],
    });
    expect(findScheduleConflict(week)).toBeNull();
  });
});

describe('conflictInlineMessages', () => {
  it('gives both ranges of a cross-day-overlap a message naming the other day', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    const tuesday = week[1];
    const mondayRangeId = newRangeId();
    const tuesdayRangeId = newRangeId();
    if (monday && tuesday) {
      monday.enabled = true;
      monday.ranges = [{ id: mondayRangeId, start: '22:00', end: '02:00' }];
      tuesday.enabled = true;
      tuesday.ranges = [{ id: tuesdayRangeId, start: '01:00', end: '09:00' }];
    }
    const conflict = findScheduleConflict(week);
    expect(conflict).not.toBeNull();
    if (!conflict) return;
    const messages = conflictInlineMessages(conflict, week);
    expect(messages[mondayRangeId]).toMatch(/Tuesday/);
    expect(messages[tuesdayRangeId]).toMatch(/Monday/);
  });

  it('gives both ranges of a same-day-overlap the "on the same day" phrasing', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    const firstId = newRangeId();
    const secondId = newRangeId();
    if (monday) {
      monday.enabled = true;
      monday.ranges = [
        { id: firstId, start: '09:00', end: '12:00' },
        { id: secondId, start: '11:00', end: '14:00' },
      ];
    }
    const conflict = findScheduleConflict(week);
    expect(conflict).not.toBeNull();
    if (!conflict) return;
    const messages = conflictInlineMessages(conflict, week);
    expect(messages[firstId]).toMatch(/on the same day/);
    expect(messages[secondId]).toMatch(/on the same day/);
  });

  it('gives both ranges of a two-overnight conflict the same sentence', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    const firstId = newRangeId();
    const secondId = newRangeId();
    if (monday) {
      monday.enabled = true;
      monday.ranges = [
        { id: firstId, start: '20:00', end: '01:00' },
        { id: secondId, start: '21:00', end: '02:00' },
      ];
    }
    const conflict = findScheduleConflict(week);
    expect(conflict).not.toBeNull();
    if (!conflict) return;
    const messages = conflictInlineMessages(conflict, week);
    expect(messages[firstId]).toBe('Only one range per day can run past midnight.');
    expect(messages[secondId]).toBe('Only one range per day can run past midnight.');
  });

  it('returns {} when a range id is no longer in the week', () => {
    const staleConflict = {
      kind: 'same-day-overlap' as const,
      dayIndex: 0,
      rangeId: 'gone-1',
      conflictDayIndex: 0,
      conflictRangeId: 'gone-2',
      message: 'stale',
    };
    expect(conflictInlineMessages(staleConflict, createDefaultWeek())).toEqual({});
  });
});

describe('hasOvernightWindow / hasLateWindow', () => {
  it('flags a crossing week overnight, not late', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = true;
      monday.ranges = [{ id: newRangeId(), start: '21:00', end: '01:00' }];
    }
    expect(hasOvernightWindow(week)).toBe(true);
    expect(hasLateWindow(week)).toBe(false);
  });

  it('does not flag a range ending exactly at 22:00 as late', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = true;
      monday.ranges = [{ id: newRangeId(), start: '18:00', end: '22:00' }];
    }
    expect(hasLateWindow(week)).toBe(false);
    expect(hasOvernightWindow(week)).toBe(false);
  });

  it('flags a range ending at 22:15 as late', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = true;
      monday.ranges = [{ id: newRangeId(), start: '18:00', end: '22:15' }];
    }
    expect(hasLateWindow(week)).toBe(true);
  });

  it('ignores a disabled day for both flags', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = false;
      monday.ranges = [{ id: newRangeId(), start: '21:00', end: '01:00' }];
    }
    expect(hasOvernightWindow(week)).toBe(false);
    expect(hasLateWindow(week)).toBe(false);
  });
});
