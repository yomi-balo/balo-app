import { describe, it, expect } from 'vitest';
import { SCHEDULE_EVENTS } from './schedule';

describe('SCHEDULE_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(SCHEDULE_EVENTS)).toEqual([
      'SAVED',
      'BOOKING_RULES_SAVED',
      'TIMEZONE_CHANGED',
      'CLEARED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(SCHEDULE_EVENTS.SAVED).toBe('schedule_saved');
    expect(SCHEDULE_EVENTS.BOOKING_RULES_SAVED).toBe('booking_rules_saved');
    expect(SCHEDULE_EVENTS.TIMEZONE_CHANGED).toBe('schedule_timezone_changed');
    expect(SCHEDULE_EVENTS.CLEARED).toBe('schedule_cleared');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(SCHEDULE_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
