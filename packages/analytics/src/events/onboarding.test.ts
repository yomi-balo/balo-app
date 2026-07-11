import { describe, it, expect } from 'vitest';
import { ONBOARDING_EVENTS } from './onboarding';

describe('ONBOARDING_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(ONBOARDING_EVENTS)).toEqual([
      'STEP_VIEWED',
      'STEP_COMPLETED',
      'COMPLETED',
      'LANDING_REACHED',
      'FORCED_ON_LOGIN',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(ONBOARDING_EVENTS.STEP_VIEWED).toBe('onboarding_step_viewed');
    expect(ONBOARDING_EVENTS.STEP_COMPLETED).toBe('onboarding_step_completed');
    expect(ONBOARDING_EVENTS.COMPLETED).toBe('onboarding_completed');
    // BAL-361
    expect(ONBOARDING_EVENTS.LANDING_REACHED).toBe('onboarding_landing_reached');
    expect(ONBOARDING_EVENTS.FORCED_ON_LOGIN).toBe('onboarding_forced_on_login');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(ONBOARDING_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
