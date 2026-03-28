import { describe, it, expect } from 'vitest';
import { PHONE_EVENTS } from './phone';

describe('PHONE_EVENTS', () => {
  it('exports PHONE_VERIFIED with the correct event name', () => {
    expect(PHONE_EVENTS.PHONE_VERIFIED).toBe('expert_phone_verified');
  });

  it('has exactly the expected keys', () => {
    expect(Object.keys(PHONE_EVENTS)).toEqual(['PHONE_VERIFIED']);
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(PHONE_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
