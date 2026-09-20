import { describe, it, expect } from 'vitest';
import type { AvailabilitySlotDto } from '@balo/shared/availability';
import { suggestTimes } from './suggest-times';

// TZ=UTC (CLAUDE.md's web test convention) makes the bare UTC offsets below double as the
// "local" calendar day/time-of-day `suggestTimes` groups by.
const ORIGINAL = '2026-09-20T09:00:00.000Z'; // Sun 20 Sep, 9:00 am

function slot(iso: string, maxDuration = 30): AvailabilitySlotDto {
  const end = new Date(new Date(iso).getTime() + maxDuration * 60_000).toISOString();
  return { start: iso, end, maxDuration };
}

describe('suggestTimes', () => {
  it('collapses same-evening 15-minute-grid slots to ONE per day — the 9:00/9:15/9:30 case', () => {
    const slots = [
      slot('2026-09-21T21:00:00.000Z'), // Mon, 9:00 pm — gap 720 from original
      slot('2026-09-21T21:15:00.000Z'), // Mon, 9:15 pm — gap 735
      slot('2026-09-21T21:30:00.000Z'), // Mon, 9:30 pm — gap 750
    ];

    const result = suggestTimes(slots, ORIGINAL);

    expect(result).toHaveLength(1);
    expect(result[0]?.start).toBe('2026-09-21T21:00:00.000Z');
  });

  it('picks the slot NEAREST the original time of day, not the first one seen', () => {
    const slots = [
      slot('2026-09-22T08:00:00.000Z'), // 8:00 am — gap 60, seen FIRST
      slot('2026-09-22T09:30:00.000Z'), // 9:30 am — gap 30, closer, seen second
    ];

    const result = suggestTimes(slots, ORIGINAL);

    expect(result).toHaveLength(1);
    expect(result[0]?.start).toBe('2026-09-22T09:30:00.000Z');
  });

  it('does not let a later, farther candidate displace an already-nearest pick', () => {
    const slots = [
      slot('2026-09-22T09:30:00.000Z'), // 9:30 am — gap 30, seen FIRST, nearest
      slot('2026-09-22T08:00:00.000Z'), // 8:00 am — gap 60, seen second, farther
    ];

    const result = suggestTimes(slots, ORIGINAL);

    expect(result).toHaveLength(1);
    expect(result[0]?.start).toBe('2026-09-22T09:30:00.000Z');
  });

  it('excludes the original slot itself, even when nothing else that day is offered', () => {
    const slots = [
      slot('2026-09-20T09:00:00.000Z'), // same day, same time as ORIGINAL
      slot('2026-09-21T09:00:00.000Z'),
    ];

    const result = suggestTimes(slots, ORIGINAL);

    expect(result.map((s) => s.start)).toEqual(['2026-09-21T09:00:00.000Z']);
  });

  it('caps at four days, earliest first, even with more days available', () => {
    const slots = [
      slot('2026-09-25T09:00:00.000Z'),
      slot('2026-09-21T09:00:00.000Z'),
      slot('2026-09-24T09:00:00.000Z'),
      slot('2026-09-22T09:00:00.000Z'),
      slot('2026-09-23T09:00:00.000Z'),
    ];

    const result = suggestTimes(slots, ORIGINAL);

    expect(result.map((s) => s.start)).toEqual([
      '2026-09-21T09:00:00.000Z',
      '2026-09-22T09:00:00.000Z',
      '2026-09-23T09:00:00.000Z',
      '2026-09-24T09:00:00.000Z',
    ]);
  });

  it('returns nothing when there are no candidate slots', () => {
    expect(suggestTimes([], ORIGINAL)).toEqual([]);
  });
});
