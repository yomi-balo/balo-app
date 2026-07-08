import { describe, it, expect } from 'vitest';
import { DOMAIN_JOIN_EVENTS } from './domain-join';

describe('DOMAIN_JOIN_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(DOMAIN_JOIN_EVENTS)).toEqual([
      'INTERSTITIAL_VIEWED',
      'INTERSTITIAL_CONTINUED',
      'INTERSTITIAL_OPTED_OUT',
      'REQUEST_PENDING_VIEWED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(DOMAIN_JOIN_EVENTS.INTERSTITIAL_VIEWED).toBe('domain_join_interstitial_viewed');
    expect(DOMAIN_JOIN_EVENTS.INTERSTITIAL_CONTINUED).toBe('domain_join_interstitial_continued');
    expect(DOMAIN_JOIN_EVENTS.INTERSTITIAL_OPTED_OUT).toBe('domain_join_interstitial_opted_out');
    expect(DOMAIN_JOIN_EVENTS.REQUEST_PENDING_VIEWED).toBe('join_request_pending_viewed');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(DOMAIN_JOIN_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
