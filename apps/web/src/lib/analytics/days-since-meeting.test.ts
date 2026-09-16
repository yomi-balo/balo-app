import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daysSinceMeeting } from './days-since-meeting';

const NOW_ISO = '2026-08-06T10:00:00.000Z';

describe('daysSinceMeeting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('floors exactly 5 days to 5', () => {
    expect(daysSinceMeeting('2026-08-01T10:00:00.000Z')).toBe(5);
  });

  it('floors 5 days 23h59m to 5, not 6', () => {
    expect(daysSinceMeeting('2026-07-31T10:00:01.000Z')).toBe(5);
  });

  it('returns 0 for the same instant', () => {
    expect(daysSinceMeeting(NOW_ISO)).toBe(0);
  });

  it('never returns negative — a future timestamp reads 0', () => {
    expect(daysSinceMeeting('2026-08-07T10:00:00.000Z')).toBe(0);
  });

  it('returns 0 for an unparseable timestamp, never NaN', () => {
    expect(daysSinceMeeting('nope')).toBe(0);
  });
});
