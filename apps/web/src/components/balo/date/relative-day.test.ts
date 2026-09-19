import { describe, expect, it } from 'vitest';

import { relativeDay } from './relative-day';

const MELBOURNE = 'Australia/Melbourne';

describe('relativeDay', () => {
  // 2026-09-21 06:00 UTC == 2026-09-21 4:00 pm in Melbourne (UTC+10).
  const NOW = new Date('2026-09-21T06:00:00.000Z');

  it('is today for a later instant on the same viewer-zone day', () => {
    expect(relativeDay('2026-09-21T08:00:00.000Z', MELBOURNE, NOW)).toBe('today');
  });

  it('is today for an EARLIER instant on the same viewer-zone day', () => {
    // 2026-09-21 00:30 UTC == 10:30 am Melbourne — earlier today, still today.
    expect(relativeDay('2026-09-21T00:30:00.000Z', MELBOURNE, NOW)).toBe('today');
  });

  it('is tomorrow for the next viewer-zone day', () => {
    expect(relativeDay('2026-09-22T06:00:00.000Z', MELBOURNE, NOW)).toBe('tomorrow');
  });

  it('is null two days out, so the caller renders an absolute date', () => {
    expect(relativeDay('2026-09-23T06:00:00.000Z', MELBOURNE, NOW)).toBeNull();
  });

  it('is null for the past', () => {
    expect(relativeDay('2026-09-20T06:00:00.000Z', MELBOURNE, NOW)).toBeNull();
    expect(relativeDay('2026-09-15T02:00:00.000Z', MELBOURNE, NOW)).toBeNull();
  });

  /** Two instants 40 minutes apart, on opposite sides of midnight: the nearer is "tomorrow". */
  it('splits on viewer-zone midnight, not on elapsed time', () => {
    // 2026-09-21 13:40 UTC == 11:40 pm Melbourne (today).
    expect(relativeDay('2026-09-21T13:40:00.000Z', MELBOURNE, NOW)).toBe('today');
    // 2026-09-21 14:20 UTC == 12:20 am on the 22nd in Melbourne (tomorrow).
    expect(relativeDay('2026-09-21T14:20:00.000Z', MELBOURNE, NOW)).toBe('tomorrow');
  });

  /**
   * One instant, one `now`, three viewers — and the zone moves BOTH sides of the comparison:
   * Melbourne is "tomorrow" because the meeting crossed midnight, Los Angeles because `now` has
   * not left the 20th. Comparing against a UTC "today" would get Los Angeles wrong alone.
   */
  it('answers per viewer zone for one instant, moving both sides of the comparison', () => {
    const iso = '2026-09-21T16:00:00.000Z';
    expect(relativeDay(iso, MELBOURNE, NOW)).toBe('tomorrow');
    expect(relativeDay(iso, 'Europe/London', NOW)).toBe('today');
    expect(relativeDay(iso, 'America/Los_Angeles', NOW)).toBe('tomorrow');
  });

  /**
   * ⚠⚠ THESE TWO PIN `nextDayKey`'S CALENDAR ARITHMETIC, and the discriminating instant is the
   * EVENING BEFORE the irregular day, never a time on it. `now + 86_400_000` lands on the right
   * date from almost anywhere — including from 10 am on the 23-hour day itself. Only within an
   * hour of the boundary can the gained or lost hour push the naive answer onto the wrong date.
   */
  it('gets tomorrow right from the evening before a 23-hour day', () => {
    // Melbourne springs forward at 2 am on 4 Oct 2026. Sat 3 Oct, 11:30 pm AEST.
    // `now + 24h` is 00:30 am on the 5th, which SKIPS the 4th entirely and answers null.
    const springEve = new Date('2026-10-03T13:30:00.000Z');
    expect(relativeDay('2026-10-03T13:45:00.000Z', MELBOURNE, springEve)).toBe('today');
    // 2026-10-04 01:00 UTC == 4 Oct, 12:00 pm Melbourne (AEDT).
    expect(relativeDay('2026-10-04T01:00:00.000Z', MELBOURNE, springEve)).toBe('tomorrow');
  });

  it('gets tomorrow right from just after midnight on a 25-hour day', () => {
    // Melbourne falls back at 3 am on 5 Apr 2026. Sun 5 Apr, 12:30 am AEDT — `now + 24h` is
    // 11:30 pm on the SAME 5th, so the naive answer calls today tomorrow and the 6th null.
    const autumnMidnight = new Date('2026-04-04T13:30:00.000Z');
    expect(relativeDay('2026-04-04T23:00:00.000Z', MELBOURNE, autumnMidnight)).toBe('today');
    // 2026-04-05 23:00 UTC == 6 Apr, 9:00 am Melbourne (AEST).
    expect(relativeDay('2026-04-05T23:00:00.000Z', MELBOURNE, autumnMidnight)).toBe('tomorrow');
  });

  it('rolls across a month boundary', () => {
    const eom = new Date('2026-09-30T06:00:00.000Z'); // 30 Sept, 4 pm Melbourne
    expect(relativeDay('2026-10-01T02:00:00.000Z', MELBOURNE, eom)).toBe('tomorrow');
  });
});
