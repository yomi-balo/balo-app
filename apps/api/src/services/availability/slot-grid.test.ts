import { describe, expect, it } from 'vitest';
import { formatInTimeZone } from 'date-fns-tz';
import {
  alignToLocalSlotBoundary,
  floorToLadder,
  gridFromFreeIntervals,
  listBookableSlots,
} from './slot-grid.js';
import type { BusyBlock, ResolverRule } from './types.js';

describe('alignToLocalSlotBoundary', () => {
  it('returns an equal instant when already aligned', () => {
    const instant = new Date('2026-06-01T09:00:00.000Z');
    expect(alignToLocalSlotBoundary(instant, 'UTC').getTime()).toBe(instant.getTime());
  });

  it(':07 rounds up to :15', () => {
    const instant = new Date('2026-06-01T09:07:00.000Z');
    expect(alignToLocalSlotBoundary(instant, 'UTC').toISOString()).toBe('2026-06-01T09:15:00.000Z');
  });

  it(':59:30 rounds up into the next hour', () => {
    const instant = new Date('2026-06-01T09:59:30.000Z');
    expect(alignToLocalSlotBoundary(instant, 'UTC').toISOString()).toBe('2026-06-01T10:00:00.000Z');
  });

  it('lands on local :00/:15/:30/:45 for a +05:30 zone (Asia/Kolkata)', () => {
    // 09:00:07 UTC = 14:30:07 IST -> next boundary 14:45 IST = 09:15:00 UTC
    const instant = new Date('2026-06-01T09:00:07.000Z');
    const aligned = alignToLocalSlotBoundary(instant, 'Asia/Kolkata');
    expect(aligned.toISOString()).toBe('2026-06-01T09:15:00.000Z');
  });

  it('lands on local :00/:15/:30/:45 for a +12:45 zone (Pacific/Chatham)', () => {
    const instant = new Date('2026-06-01T09:00:01.000Z');
    const aligned = alignToLocalSlotBoundary(instant, 'Pacific/Chatham');
    // Any aligned instant, re-zoned, must sit on a 15-min local boundary.
    const rezoned = alignToLocalSlotBoundary(aligned, 'Pacific/Chatham');
    expect(rezoned.getTime()).toBe(aligned.getTime());
    expect(aligned.getTime()).toBeGreaterThan(instant.getTime());
  });
});

describe('floorToLadder', () => {
  it.each([
    [15, 15],
    [29, 15],
    [30, 30],
    [44, 30],
    [47, 45],
    [59, 45],
    [60, 60],
    [240, 60], // the ladder cap, D5
  ])('floorToLadder(%i) === %i', (raw, expected) => {
    expect(floorToLadder(raw)).toBe(expected);
  });

  it('is always a member of SLOT_DURATION_LADDER for any raw >= 15', () => {
    for (let raw = 15; raw <= 500; raw += 1) {
      expect([15, 30, 45, 60]).toContain(floorToLadder(raw));
    }
  });
});

describe('gridFromFreeIntervals', () => {
  it('a 09:00-12:00 interval yields 12 starts; first maxDuration 60, last (11:45) maxDuration 15', () => {
    const interval: BusyBlock = {
      startAt: new Date('2026-06-01T09:00:00.000Z'),
      endAt: new Date('2026-06-01T12:00:00.000Z'),
    };
    const slots = gridFromFreeIntervals([interval], 'UTC');
    expect(slots).toHaveLength(12);
    expect(slots[0]?.maxDurationMinutes).toBe(60);
    expect(slots.at(-1)?.startAt.toISOString()).toBe('2026-06-01T11:45:00.000Z');
    expect(slots.at(-1)?.maxDurationMinutes).toBe(15);
  });

  it('an interval of exactly 14 minutes emits nothing', () => {
    const interval: BusyBlock = {
      startAt: new Date('2026-06-01T09:00:00.000Z'),
      endAt: new Date('2026-06-01T09:14:00.000Z'),
    };
    expect(gridFromFreeIntervals([interval], 'UTC')).toEqual([]);
  });

  it('a 09:07-10:00 interval starts at 09:15', () => {
    const interval: BusyBlock = {
      startAt: new Date('2026-06-01T09:07:00.000Z'),
      endAt: new Date('2026-06-01T10:00:00.000Z'),
    };
    const slots = gridFromFreeIntervals([interval], 'UTC');
    expect(slots[0]?.startAt.toISOString()).toBe('2026-06-01T09:15:00.000Z');
  });

  it('returns starts in ascending order across multiple intervals', () => {
    const intervals: BusyBlock[] = [
      {
        startAt: new Date('2026-06-02T09:00:00.000Z'),
        endAt: new Date('2026-06-02T09:30:00.000Z'),
      },
      {
        startAt: new Date('2026-06-01T09:00:00.000Z'),
        endAt: new Date('2026-06-01T09:30:00.000Z'),
      },
    ];
    const slots = gridFromFreeIntervals(intervals, 'UTC');
    const times = slots.map((s) => s.startAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('maxDuration never exceeds the remaining minutes in the interval', () => {
    const interval: BusyBlock = {
      startAt: new Date('2026-06-01T09:00:00.000Z'),
      endAt: new Date('2026-06-01T10:07:00.000Z'),
    };
    const slots = gridFromFreeIntervals([interval], 'UTC');
    for (const slot of slots) {
      const remaining = (interval.endAt.getTime() - slot.startAt.getTime()) / 60_000;
      expect(slot.maxDurationMinutes).toBeLessThanOrEqual(remaining);
    }
  });

  it('DST spring-forward (Australia/Sydney, 2026-10-04): every start is on a 15-min local boundary, none in the skipped hour', () => {
    // Sydney: clocks jump 02:00 -> 03:00 AEDT on 2026-10-04. Interval spans the transition.
    const interval: BusyBlock = {
      startAt: new Date('2026-10-03T14:00:00.000Z'), // 2026-10-04 00:00 AEST
      endAt: new Date('2026-10-03T18:00:00.000Z'), // 2026-10-04 05:00 AEDT
    };
    const slots = gridFromFreeIntervals([interval], 'Australia/Sydney');
    expect(slots.length).toBeGreaterThan(0);
    const labels = slots.map((s) => formatInTimeZone(s.startAt, 'Australia/Sydney', 'HH:mm'));
    for (const slot of slots) {
      const aligned = alignToLocalSlotBoundary(slot.startAt, 'Australia/Sydney');
      expect(aligned.getTime()).toBe(slot.startAt.getTime());
    }
    // The half of the title the old version never asserted: the 02:00–02:59 wall clock does not
    // exist that morning, so no start may carry a label in it.
    expect(labels.filter((label) => label.startsWith('02:'))).toEqual([]);
    // A positive control, so the assertion above cannot pass on an empty/short grid.
    expect(labels).toContain('01:45');
    expect(labels).toContain('03:00');
  });

  it('DST fall-back (Australia/Sydney, 2026-04-05): the repeated hour yields two distinct instants with the same wall-clock label', () => {
    // Sydney: clocks fall back 03:00 -> 02:00 AEST on 2026-04-05. 02:15 occurs twice.
    const interval: BusyBlock = {
      startAt: new Date('2026-04-04T15:00:00.000Z'), // 2026-04-05 02:00 AEDT
      endAt: new Date('2026-04-04T18:00:00.000Z'), // 2026-04-05 04:00 AEST
    };
    const slots = gridFromFreeIntervals([interval], 'Australia/Sydney');
    const startTimes = slots.map((s) => s.startAt.getTime());
    // No duplicate instants — every start is distinct even though wall-clock labels repeat.
    expect(new Set(startTimes).size).toBe(startTimes.length);
    expect(slots.length).toBeGreaterThan(0);
    // ⚠ THE CLAIM IN THE TITLE. Distinctness alone is vacuously true of any monotonic grid and
    // says nothing about repetition; assert that a wall-clock label really does occur twice.
    const labels = slots.map((s) => formatInTimeZone(s.startAt, 'Australia/Sydney', 'HH:mm'));
    const repeated = labels.filter((label, i) => labels.indexOf(label) !== i);
    expect(repeated).toContain('02:15');
  });

  it('cross-midnight: a 22:00->02:00 interval yields starts on both local dates', () => {
    const interval: BusyBlock = {
      startAt: new Date('2026-06-01T22:00:00.000Z'),
      endAt: new Date('2026-06-02T02:00:00.000Z'),
    };
    const slots = gridFromFreeIntervals([interval], 'UTC');
    // ⚠ `formatInTimeZone`, never `toISOString().slice(0, 10)` — the pattern
    // `availability-day-keys.ts` bans by name. Harmless in a UTC fixture, but anyone grepping
    // for the banned pattern should find zero hits in this feature.
    const dates = new Set(slots.map((s) => formatInTimeZone(s.startAt, 'UTC', 'yyyy-MM-dd')));
    expect(dates.has('2026-06-01')).toBe(true);
    expect(dates.has('2026-06-02')).toBe(true);
  });
});

describe('listBookableSlots', () => {
  const rule: ResolverRule = { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }; // Monday

  it('leadGuardMinutes pushes the first slot forward on top of minimumNoticeMinutes', () => {
    // 2026-06-01 is a Monday.
    const now = new Date('2026-06-01T09:00:00.000Z');
    const withoutGuard = listBookableSlots({
      rules: [rule],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 1,
      minimumNoticeMinutes: 30,
      leadGuardMinutes: 0,
    });
    const withGuard = listBookableSlots({
      rules: [rule],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 1,
      minimumNoticeMinutes: 30,
      leadGuardMinutes: 15,
    });
    expect(withoutGuard[0]?.startAt.getTime()).toBeLessThan(withGuard[0]?.startAt.getTime() ?? 0);
  });

  it('horizonDays bounds the far edge', () => {
    const now = new Date('2026-06-01T09:00:00.000Z');
    const slots = listBookableSlots({
      rules: [rule],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 1,
    });
    for (const slot of slots) {
      expect(slot.startAt.getTime()).toBeLessThan(now.getTime() + 24 * 60 * 60 * 1000);
    }
  });

  it('empty rules -> []', () => {
    const slots = listBookableSlots({
      rules: [],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now: new Date('2026-06-01T09:00:00.000Z'),
      horizonDays: 14,
    });
    expect(slots).toEqual([]);
  });
});
