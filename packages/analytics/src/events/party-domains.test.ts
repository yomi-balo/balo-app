import { describe, it, expect } from 'vitest';
import { PARTY_DOMAIN_SERVER_EVENTS } from './party-domains';

describe('PARTY_DOMAIN_SERVER_EVENTS', () => {
  it('has exactly the expected keys (CAPTURED/CAPTURE_SKIPPED retired in BAL-369)', () => {
    expect(Object.keys(PARTY_DOMAIN_SERVER_EVENTS)).toEqual(['ADDED', 'REMOVED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(PARTY_DOMAIN_SERVER_EVENTS.ADDED).toBe('party_domain_added');
    expect(PARTY_DOMAIN_SERVER_EVENTS.REMOVED).toBe('party_domain_removed');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(PARTY_DOMAIN_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
