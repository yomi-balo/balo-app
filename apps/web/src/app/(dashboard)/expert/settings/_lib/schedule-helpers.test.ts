import { describe, it, expect } from 'vitest';
import {
  BUFFER_OPTIONS,
  DEFAULT_BOOKING_SETTINGS,
  NOTICE_OPTIONS,
  TIME_OPTIONS,
  WINDOW_OPTIONS,
  countEnabledDays,
  createDefaultWeek,
  createEmptyWeek,
  findDstConflict,
  formatHhmm,
  hasSplitDays,
  hhmmToMinutes,
  minutesToHhmm,
  newRangeId,
  rulesToWeek,
  summarizeWeek,
  validateWeek,
  weekToRules,
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

describe('option sets', () => {
  it('matches the exact design-reference option sets', () => {
    expect(BUFFER_OPTIONS.map((o) => o.value)).toEqual([0, 5, 10, 15, 30]);
    expect(NOTICE_OPTIONS.map((o) => o.value)).toEqual([0, 60, 120, 240, 720, 1440, 2880]);
    expect(WINDOW_OPTIONS.map((o) => o.value)).toEqual([14, 30, 60, 90]);
  });

  it('defaults the booking window to 60 days', () => {
    expect(DEFAULT_BOOKING_SETTINGS.windowDays).toBe(60);
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

  it('flags a range whose end is not after its start', () => {
    const week = createEmptyWeek();
    const monday = week[0];
    if (monday) {
      monday.enabled = true;
      monday.ranges = [{ id: newRangeId(), start: '17:00', end: '09:00' }];
    }
    expect(validateWeek(week)).not.toBeNull();
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
});

describe('findDstConflict', () => {
  const FROM = new Date('2026-01-01T00:00:00Z');

  it('returns the gap when a Sunday range overlaps the Melbourne spring-forward', () => {
    const week: WeekState = createEmptyWeek();
    const sunday = week[6];
    if (sunday) {
      sunday.enabled = true;
      sunday.ranges = [{ id: newRangeId(), start: '01:00', end: '04:00' }];
    }
    const gap = findDstConflict(week, 'Australia/Melbourne', FROM);
    expect(gap?.gapStartMinutes).toBe(120);
  });

  it('returns null for a default week (no Sunday) even in a DST zone', () => {
    expect(findDstConflict(createDefaultWeek(), 'Australia/Melbourne', FROM)).toBeNull();
  });
});
