import { describe, it, expect, vi } from 'vitest';
import { formatAsOfUtc } from './format-as-of.js';

describe('formatAsOfUtc', () => {
  it('renders the time, "UTC", then the long date — lower-case pm', () => {
    expect(formatAsOfUtc('2026-09-23T14:05:00.000Z')).toBe('2:05 pm UTC, 23 September 2026');
  });

  it('renders a morning instant with a lower-case am', () => {
    expect(formatAsOfUtc('2026-01-05T09:30:00.000Z')).toBe('9:30 am UTC, 5 January 2026');
  });

  it('renders midnight and noon as 12 am / 12 pm', () => {
    expect(formatAsOfUtc('2026-03-01T00:00:00.000Z')).toBe('12:00 am UTC, 1 March 2026');
    expect(formatAsOfUtc('2026-03-01T12:00:00.000Z')).toBe('12:00 pm UTC, 1 March 2026');
  });

  it('reads the UTC clock (an offset instant is normalised)', () => {
    expect(formatAsOfUtc('2026-09-24T01:05:00+11:00')).toBe('2:05 pm UTC, 23 September 2026');
  });

  // The formatters are built once at module load, and on a UTC runner a formatter with no
  // `timeZone` gives the same answer — so the output alone cannot pin the zone. Pin the option.
  it('builds both of its formatters with an explicit UTC timeZone, whatever the runner zone', async () => {
    const construct = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      vi.resetModules();
      await import('./format-as-of.js');
      const zones = construct.mock.calls.map(([, options]) => options?.timeZone);
      expect(zones).toEqual(['UTC', 'UTC']);
    } finally {
      construct.mockRestore();
    }
  });

  it('degrades to a readable phrase, never "Invalid Date", for an unparseable input', () => {
    const label = formatAsOfUtc('not-a-date');
    expect(label).toBe('the time of this notice');
    expect(label).not.toMatch(/invalid|NaN/i);
  });
});
