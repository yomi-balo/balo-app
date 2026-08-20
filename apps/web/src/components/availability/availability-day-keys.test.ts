import { describe, expect, it } from 'vitest';
import type { AvailabilitySlotDto } from '@balo/shared/availability';
import {
  calendarDateToDayKey,
  dayKeyToCalendarDate,
  formatSlotTime,
  formatTimezoneLabel,
  formatWeekdayShort,
  groupSlotsByDay,
  slotCrossesMidnight,
  slotDayKey,
  todayDayKey,
} from './availability-day-keys';

describe('slotDayKey', () => {
  it('maps the same instant to different day keys for viewers behind and ahead of UTC', () => {
    const instant = '2026-08-26T23:30:00.000Z';
    const behind = slotDayKey(instant, 'America/Los_Angeles'); // UTC-7/8
    const ahead = slotDayKey(instant, 'Australia/Sydney'); // UTC+10/11
    expect(behind).not.toBe(ahead);
  });

  it('the prototype regression: 2026-08-26T14:00:00Z is 2026-08-27 for a Sydney viewer, NOT the UTC day', () => {
    const instant = '2026-08-26T14:00:00.000Z';
    const sydneyKey = slotDayKey(instant, 'Australia/Sydney');
    expect(sydneyKey).toBe('2026-08-27');
    expect(sydneyKey).not.toBe(instant.slice(0, 10)); // the banned toISOString().slice(0,10) pattern
  });
});

describe('dayKeyToCalendarDate / calendarDateToDayKey round-trip', () => {
  it('round-trips exactly for a month of keys', () => {
    for (let day = 1; day <= 28; day += 1) {
      const key = `2026-09-${day.toString().padStart(2, '0')}`;
      expect(calendarDateToDayKey(dayKeyToCalendarDate(key))).toBe(key);
    }
  });
});

describe('todayDayKey', () => {
  it('differs across two zones straddling midnight', () => {
    // 23:30 UTC is already "tomorrow" in Sydney but still "today" in Los Angeles.
    const now = new Date('2026-08-26T23:30:00.000Z');
    const sydney = todayDayKey('Australia/Sydney', now);
    const la = todayDayKey('America/Los_Angeles', now);
    expect(sydney).not.toBe(la);
  });
});

describe('groupSlotsByDay', () => {
  function slot(startIso: string): AvailabilitySlotDto {
    return { start: startIso, end: startIso, maxDuration: 15 };
  }

  it('preserves ascending order within each day', () => {
    const slots = [
      slot('2026-06-01T09:00:00.000Z'),
      slot('2026-06-01T10:00:00.000Z'),
      slot('2026-06-01T11:00:00.000Z'),
    ];
    const grouped = groupSlotsByDay(slots, 'UTC');
    const day = grouped.get('2026-06-01');
    expect(day?.map((s) => s.start)).toEqual([
      '2026-06-01T09:00:00.000Z',
      '2026-06-01T10:00:00.000Z',
      '2026-06-01T11:00:00.000Z',
    ]);
  });

  it('buckets a cross-midnight pair onto two viewer-zone days', () => {
    const slots = [slot('2026-06-01T23:45:00.000Z'), slot('2026-06-02T00:15:00.000Z')];
    const grouped = groupSlotsByDay(slots, 'UTC');
    expect(grouped.has('2026-06-01')).toBe(true);
    expect(grouped.has('2026-06-02')).toBe(true);
    expect(grouped.get('2026-06-01')).toHaveLength(1);
    expect(grouped.get('2026-06-02')).toHaveLength(1);
  });
});

describe('slotCrossesMidnight / formatWeekdayShort', () => {
  it('true when the slot ends on a later viewer-zone day (D10 crossing marker)', () => {
    const slot = { start: '2026-06-05T23:45:00.000Z', end: '2026-06-06T00:45:00.000Z' };
    expect(slotCrossesMidnight(slot, 'UTC')).toBe(true);
    expect(formatWeekdayShort(slot.end, 'UTC')).toBe('Sat');
  });

  it('false when the slot stays inside its own day', () => {
    const slot = { start: '2026-06-05T09:00:00.000Z', end: '2026-06-05T10:00:00.000Z' };
    expect(slotCrossesMidnight(slot, 'UTC')).toBe(false);
  });

  it('⚠ is answered in the VIEWER zone — the same instants cross in one zone and not another', () => {
    // 13:30–14:30 UTC is 23:30–00:30 in Sydney (UTC+10), which crosses; in UTC it does not.
    const slot = { start: '2026-06-05T13:30:00.000Z', end: '2026-06-05T14:30:00.000Z' };
    expect(slotCrossesMidnight(slot, 'UTC')).toBe(false);
    expect(slotCrossesMidnight(slot, 'Australia/Sydney')).toBe(true);
  });
});

describe('formatSlotTime', () => {
  it('renders the same instant differently in two zones', () => {
    const instant = '2026-06-01T09:00:00.000Z';
    const utc = formatSlotTime(instant, 'UTC');
    const sydney = formatSlotTime(instant, 'Australia/Sydney');
    expect(utc).not.toBe(sydney);
  });
});

describe('formatTimezoneLabel', () => {
  it('resolves a mapped city', () => {
    const label = formatTimezoneLabel('Australia/Sydney', new Date('2026-06-01T00:00:00Z'));
    expect(label).toContain('Sydney');
  });

  it('falls back to the raw IANA string when no city can be extracted', () => {
    const label = formatTimezoneLabel('UTC', new Date('2026-06-01T00:00:00Z'));
    expect(label).toContain('UTC');
  });
});
