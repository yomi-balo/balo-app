import { describe, it, expect } from 'vitest';
import { formatOverrideRange } from './format-override-range';

describe('formatOverrideRange', () => {
  it('formats a single day WITH the weekday', () => {
    expect(formatOverrideRange('2026-12-25', '2026-12-25')).toBe('Fri, 25 Dec 2026');
  });

  it('formats a multi-day range WITHOUT the weekday, joined by an en dash', () => {
    expect(formatOverrideRange('2026-12-25', '2027-01-02')).toBe('25 Dec 2026 – 2 Jan 2027');
  });

  it('formats a range within the same month', () => {
    expect(formatOverrideRange('2026-12-24', '2026-12-26')).toBe('24 Dec 2026 – 26 Dec 2026');
  });

  it('falls back to the raw ISO string for an unparsable date', () => {
    expect(formatOverrideRange('not-a-date', 'not-a-date')).toBe('not-a-date');
  });
});
