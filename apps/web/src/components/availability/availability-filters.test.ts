import { describe, expect, it } from 'vitest';
import type { AvailabilitySlotDto } from '@balo/shared/availability';
import {
  availableLengths,
  dropPastSlots,
  fallbackLength,
  fitsLength,
  isSlotDurationMinutes,
  nextDayAtLength,
  soonerOffers,
  splitDaysByLength,
} from './availability-filters';

function slot(start: string, maxDuration: number): AvailabilitySlotDto {
  return { start, end: start, maxDuration };
}
const T9 = '2026-06-01T09:00:00.000Z';
const T10 = '2026-06-01T10:00:00.000Z';
const T11 = '2026-06-01T11:00:00.000Z';
const T12 = '2026-06-01T12:00:00.000Z';

describe('isSlotDurationMinutes', () => {
  it('accepts ladder values and rejects others', () => {
    expect(isSlotDurationMinutes(45)).toBe(true);
    expect(isSlotDurationMinutes(37)).toBe(false);
  });
});

describe('fitsLength / availableLengths', () => {
  it('fits when maxDuration reaches the length', () => {
    expect(fitsLength(slot(T9, 45), 45)).toBe(true);
    expect(fitsLength(slot(T9, 30), 45)).toBe(false);
  });

  it('lists the ladder values some slot can hold', () => {
    expect([...availableLengths([slot(T9, 30), slot(T10, 15)])]).toEqual([15, 30]);
  });
});

describe('fallbackLength', () => {
  it('steps down to the largest available value', () => {
    expect(fallbackLength(60, [slot(T9, 45)])).toBe(45);
    expect(fallbackLength(60, [slot(T9, 15)])).toBe(15);
  });

  it('keeps the preferred length when it is available', () => {
    expect(fallbackLength(45, [slot(T9, 60)])).toBe(45);
  });

  it('returns the preferred length for an empty window', () => {
    expect(fallbackLength(60, [])).toBe(60);
  });
});

describe('soonerOffers', () => {
  it('is empty when nothing shorter starts earlier', () => {
    expect(soonerOffers([slot(T9, 60), slot(T10, 60)], 60)).toEqual([]);
  });

  it('offers the shorter length that starts before the first time at the chosen length', () => {
    expect(soonerOffers([slot(T9, 30), slot(T10, 60)], 60)).toEqual([{ start: T9, minutes: 30 }]);
  });

  it('keeps up to three offers, earliest first', () => {
    expect(soonerOffers([slot(T9, 15), slot(T10, 30), slot(T11, 45), slot(T12, 60)], 60)).toEqual([
      { start: T9, minutes: 15 },
      { start: T10, minutes: 30 },
      { start: T11, minutes: 45 },
    ]);
  });

  it('offers shorter calls on a day with nothing at the length', () => {
    expect(soonerOffers([slot(T9, 30), slot(T10, 45)], 60)).toEqual([
      { start: T9, minutes: 30 },
      { start: T10, minutes: 45 },
    ]);
  });

  it('drops a shorter option a longer one already covers at the same start', () => {
    expect(soonerOffers([slot(T9, 45), slot(T10, 60)], 60)).toEqual([{ start: T9, minutes: 45 }]);
  });
});

describe('splitDaysByLength / nextDayAtLength', () => {
  const byDay = new Map<string, AvailabilitySlotDto[]>([
    ['2026-06-01', [slot(T9, 60)]],
    ['2026-06-02', [slot(T10, 30)]],
    ['2026-06-03', [slot(T11, 60)]],
  ]);

  it('separates at-length days from shorter-only days', () => {
    const { daysAtLength, daysShorterOnly } = splitDaysByLength(byDay, 60, false);
    expect([...daysAtLength]).toEqual(['2026-06-01', '2026-06-03']);
    expect([...daysShorterOnly]).toEqual(['2026-06-02']);
  });

  it('has no shorter-only days while pinned', () => {
    expect(splitDaysByLength(byDay, 60, true).daysShorterOnly.size).toBe(0);
  });

  it('finds the next day at the length, or null', () => {
    const { daysAtLength } = splitDaysByLength(byDay, 60, false);
    const keys = [...byDay.keys()];
    expect(nextDayAtLength(keys, '2026-06-01', daysAtLength)).toBe('2026-06-03');
    expect(nextDayAtLength(keys, '2026-06-03', daysAtLength)).toBeNull();
  });
});

describe('dropPastSlots', () => {
  it('keeps only slots that start after now', () => {
    const now = new Date(T10);
    expect(dropPastSlots([slot(T9, 60), slot(T10, 60), slot(T11, 60)], now)).toEqual([
      slot(T11, 60),
    ]);
  });
});
