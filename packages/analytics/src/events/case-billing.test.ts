import { describe, it, expect } from 'vitest';
import { CASE_BILLING_EVENTS, CASE_BILLING_SERVER_EVENTS } from './case-billing';

// Values do NOT share a feature prefix, so the guard uses the GENERIC snake_case matcher.
const SNAKE_CASE = /^[a-z]+(_[a-z]+)*$/;

describe('CASE_BILLING_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(CASE_BILLING_EVENTS)).toEqual(['PENDING_SHOWN']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(CASE_BILLING_EVENTS.PENDING_SHOWN).toBe('case_billing_pending_shown');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(CASE_BILLING_EVENTS)) {
      expect(value).toMatch(SNAKE_CASE);
    }
  });
});

describe('CASE_BILLING_SERVER_EVENTS (server)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(CASE_BILLING_SERVER_EVENTS)).toEqual([
      'CASE_BILLING_FINALIZED',
      'CASE_OVERDRAFT_GRACE_USED',
      'EXPERT_PAYOUT_RECORDED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(CASE_BILLING_SERVER_EVENTS.CASE_BILLING_FINALIZED).toBe('case_billing_finalized');
    expect(CASE_BILLING_SERVER_EVENTS.CASE_OVERDRAFT_GRACE_USED).toBe('case_overdraft_grace_used');
    expect(CASE_BILLING_SERVER_EVENTS.EXPERT_PAYOUT_RECORDED).toBe('expert_payout_recorded');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(CASE_BILLING_SERVER_EVENTS)) {
      expect(value).toMatch(SNAKE_CASE);
    }
  });
});
