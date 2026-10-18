import { describe, expect, it } from 'vitest';
import { CALENDAR_HELP_URL } from './calendar-help';

describe('CALENDAR_HELP_URL', () => {
  it('points at the in-app calendar help guide', () => {
    expect(CALENDAR_HELP_URL).toBe('/help/connecting-your-calendar');
  });
});
