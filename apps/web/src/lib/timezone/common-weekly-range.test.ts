import { describe, it, expect } from 'vitest';
import { mostCommonWeeklyRange } from './common-weekly-range';

function weekdays(startTime: string, endTime: string, days: number[]) {
  return days.map((dayOfWeek) => ({ dayOfWeek, startTime, endTime }));
}

describe('mostCommonWeeklyRange', () => {
  it('returns null for an empty schedule', () => {
    expect(mostCommonWeeklyRange([])).toBeNull();
  });

  it('picks the range worked on the most days (Mon–Fri 9–5 beats Sat 10–2)', () => {
    const rules = [
      ...weekdays('09:00', '17:00', [1, 2, 3, 4, 5]),
      ...weekdays('10:00', '14:00', [6]),
    ];
    expect(mostCommonWeeklyRange(rules)).toEqual({ startTime: '09:00', endTime: '17:00' });
  });

  it('counts distinct days, so a split day does not double-count one range', () => {
    const rules = [...weekdays('09:00', '12:00', [1, 1, 1]), ...weekdays('13:00', '17:00', [2, 3])];
    expect(mostCommonWeeklyRange(rules)).toEqual({ startTime: '13:00', endTime: '17:00' });
  });

  it('falls back to the earliest start when every range is unique', () => {
    const rules = [
      ...weekdays('10:00', '14:00', [1]),
      ...weekdays('08:30', '12:00', [2]),
      ...weekdays('09:00', '17:00', [3]),
    ];
    expect(mostCommonWeeklyRange(rules)).toEqual({ startTime: '08:30', endTime: '12:00' });
  });

  it('breaks a 2–2 tie towards the earlier start', () => {
    const rules = [...weekdays('10:00', '18:00', [1, 2]), ...weekdays('09:00', '17:00', [3, 4])];
    expect(mostCommonWeeklyRange(rules)).toEqual({ startTime: '09:00', endTime: '17:00' });
  });

  it('breaks a tie on the same start towards the earlier end', () => {
    const rules = [...weekdays('09:00', '17:00', [1, 2]), ...weekdays('09:00', '12:00', [3, 4])];
    expect(mostCommonWeeklyRange(rules)).toEqual({ startTime: '09:00', endTime: '12:00' });
  });

  it('falls back to the earlier end when unique ranges share a start', () => {
    const rules = [...weekdays('09:00', '17:00', [1]), ...weekdays('09:00', '12:00', [2])];
    expect(mostCommonWeeklyRange(rules)).toEqual({ startTime: '09:00', endTime: '12:00' });
  });

  it('normalises HH:mm:ss to HH:mm and merges it with HH:mm', () => {
    const rules = [
      { dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' },
      { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
    ];
    expect(mostCommonWeeklyRange(rules)).toEqual({ startTime: '09:00', endTime: '17:00' });
  });

  it('preserves a range that crosses midnight', () => {
    const rules = weekdays('22:00', '02:00', [1, 2, 3]);
    expect(mostCommonWeeklyRange(rules)).toEqual({ startTime: '22:00', endTime: '02:00' });
  });
});
