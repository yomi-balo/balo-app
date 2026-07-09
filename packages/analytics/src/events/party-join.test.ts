import { describe, it, expect } from 'vitest';
import { PARTY_JOIN_SERVER_EVENTS } from './party-join';

describe('PARTY_JOIN_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(PARTY_JOIN_SERVER_EVENTS)).toEqual([
      'SIGNUP_DOMAIN_MATCHED',
      'DOMAIN_AUTO_JOIN_COMPLETED',
      'REQUEST_CREATED',
      'REQUEST_APPROVED',
      'REQUEST_DECLINED',
      'DOMAIN_JOIN_OPTED_OUT',
      'MODE_CHANGED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(PARTY_JOIN_SERVER_EVENTS.SIGNUP_DOMAIN_MATCHED).toBe('party_join_signup_domain_matched');
    expect(PARTY_JOIN_SERVER_EVENTS.DOMAIN_AUTO_JOIN_COMPLETED).toBe(
      'party_join_domain_auto_join_completed'
    );
    expect(PARTY_JOIN_SERVER_EVENTS.REQUEST_CREATED).toBe('party_join_request_created');
    expect(PARTY_JOIN_SERVER_EVENTS.REQUEST_APPROVED).toBe('party_join_request_approved');
    expect(PARTY_JOIN_SERVER_EVENTS.REQUEST_DECLINED).toBe('party_join_request_declined');
    expect(PARTY_JOIN_SERVER_EVENTS.DOMAIN_JOIN_OPTED_OUT).toBe('party_join_domain_opted_out');
    expect(PARTY_JOIN_SERVER_EVENTS.MODE_CHANGED).toBe('domain_join_mode_changed');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(PARTY_JOIN_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
