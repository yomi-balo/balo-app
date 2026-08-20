import { describe, it, expect } from 'vitest';
import { AVAILABILITY_EVENTS } from './availability';

describe('AVAILABILITY_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(AVAILABILITY_EVENTS)).toEqual([
      'CALENDAR_VIEWED',
      'SLOT_SELECTED',
      'DURATION_FILTER_USED',
      'EMPTY_STATE_SHOWN',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(AVAILABILITY_EVENTS.CALENDAR_VIEWED).toBe('availability_calendar_viewed');
    expect(AVAILABILITY_EVENTS.SLOT_SELECTED).toBe('availability_slot_selected');
    expect(AVAILABILITY_EVENTS.DURATION_FILTER_USED).toBe('availability_duration_filter_used');
    expect(AVAILABILITY_EVENTS.EMPTY_STATE_SHOWN).toBe('availability_empty_state_shown');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(AVAILABILITY_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('does not collide with CALENDAR_SERVER_EVENTS unprefixed wire names (D11)', () => {
    const values = Object.values(AVAILABILITY_EVENTS) as string[];
    expect(values).not.toContain('availability_override_created');
    expect(values).not.toContain('availability_override_deleted');
  });
});
