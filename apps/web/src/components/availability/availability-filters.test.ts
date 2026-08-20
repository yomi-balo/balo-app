import { describe, expect, it } from 'vitest';
import type { AvailabilitySlotDto } from '@balo/shared/availability';
import {
  confirmationDurations,
  derivePills,
  filterSlotsByDuration,
  isSlotDurationMinutes,
  shouldResetFilter,
} from './availability-filters';

function slot(maxDuration: AvailabilitySlotDto['maxDuration']): AvailabilitySlotDto {
  return { start: '2026-06-01T09:00:00.000Z', end: '2026-06-01T09:15:00.000Z', maxDuration };
}

describe('derivePills', () => {
  it('is ascending distinct maxDuration values prefixed by "any"', () => {
    const slots = [slot(60), slot(15), slot(30), slot(15)];
    expect(derivePills(slots)).toEqual(['any', 15, 30, 60]);
  });

  it('is just ["any"] for an empty day', () => {
    expect(derivePills([])).toEqual(['any']);
  });

  /**
   * ⚠ `maxDuration` IS UNVALIDATED WIRE DATA (typed `number`). The previous
   * `as SlotDurationMinutes[]` assertion would have laundered a rogue value into the narrow type
   * and rendered a "37 min" pill that nothing can ever match.
   */
  it('drops a duration that is not on the ladder rather than asserting it into the type', () => {
    expect(derivePills([slot(30), { ...slot(30), maxDuration: 37 }])).toEqual(['any', 30]);
  });
});

describe('isSlotDurationMinutes', () => {
  it('accepts exactly the ladder', () => {
    expect([15, 30, 45, 60].every(isSlotDurationMinutes)).toBe(true);
    expect([0, 10, 37, 61, 480].some(isSlotDurationMinutes)).toBe(false);
  });
});

describe('filterSlotsByDuration', () => {
  const slots = [slot(15), slot(30), slot(60)];

  it('"any" is the identity', () => {
    expect(filterSlotsByDuration(slots, 'any')).toEqual(slots);
  });

  it('is additive: keeps every slot whose maxDuration >= filter', () => {
    expect(filterSlotsByDuration(slots, 30)).toEqual([slot(30), slot(60)]);
  });
});

describe('shouldResetFilter', () => {
  it('true when nothing on the new day matches the active filter', () => {
    expect(shouldResetFilter([slot(15), slot(30)], 60)).toBe(true);
  });

  it('false when at least one slot matches', () => {
    expect(shouldResetFilter([slot(15), slot(60)], 60)).toBe(false);
  });

  it('"any" never needs a reset', () => {
    expect(shouldResetFilter([], 'any')).toBe(false);
  });
});

describe('confirmationDurations', () => {
  it('clamps the ladder to the selected slot maxDuration', () => {
    expect(confirmationDurations(45)).toEqual([15, 30, 45]);
    expect(confirmationDurations(60)).toEqual([15, 30, 45, 60]);
    expect(confirmationDurations(15)).toEqual([15]);
  });
});
