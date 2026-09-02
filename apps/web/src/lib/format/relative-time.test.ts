import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './relative-time';

/**
 * ⚠ MOVED VERBATIM FROM `thread-files-panel.test.tsx` (BAL-431 / OSD-2), assertion for
 * assertion. The panel it used to live beside is gone; the formatter is not, so its coverage
 * moved with it rather than being deleted.
 */
describe('formatRelativeTime', () => {
  const now = new Date('2026-06-10T12:00:00Z');

  it('formats minutes/hours/days/weeks', () => {
    expect(formatRelativeTime('2026-06-10T11:59:40.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-06-10T11:30:00.000Z', now)).toBe('30m ago');
    expect(formatRelativeTime('2026-06-10T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-06-08T12:00:00.000Z', now)).toBe('2d ago');
    expect(formatRelativeTime('2026-05-20T12:00:00.000Z', now)).toBe('3w ago');
  });

  it('defaults `now` to the current clock', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('just now');
  });
});
