import { describe, expect, it } from 'vitest';
import { formatHelpDate } from './format-help-date';

describe('formatHelpDate', () => {
  it('formats an ISO date as day, long month and year', () => {
    expect(formatHelpDate('2026-10-17')).toBe('17 October 2026');
  });

  it('does not shift the day across a year boundary', () => {
    expect(formatHelpDate('2026-01-01')).toBe('1 January 2026');
  });
});
