import { describe, it, expect } from 'vitest';
import { SIGNUP_DOMAIN_SERVER_EVENTS } from './signup-domain';

describe('SIGNUP_DOMAIN_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(SIGNUP_DOMAIN_SERVER_EVENTS)).toEqual(['CLASSIFIED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(SIGNUP_DOMAIN_SERVER_EVENTS.CLASSIFIED).toBe('signup_domain_classified');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(SIGNUP_DOMAIN_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
