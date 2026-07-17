import { describe, it, expect } from 'vitest';
import { SESSION_EVENTS, SESSION_SERVER_EVENTS } from './session';

// Values do NOT share a feature prefix, so the guard uses the GENERIC snake_case matcher.
const SNAKE_CASE = /^[a-z]+(_[a-z]+)*$/;

describe('SESSION_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(SESSION_EVENTS)).toEqual(['STARTED', 'LOW_BALANCE_WARNING_SHOWN']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(SESSION_EVENTS.STARTED).toBe('session_started');
    expect(SESSION_EVENTS.LOW_BALANCE_WARNING_SHOWN).toBe('low_balance_warning_shown');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(SESSION_EVENTS)) {
      expect(value).toMatch(SNAKE_CASE);
    }
  });
});

describe('SESSION_SERVER_EVENTS (server)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(SESSION_SERVER_EVENTS)).toEqual([
      'GRACE_ENTERED',
      'GRACE_CEILING_HIT',
      'SESSION_SETTLED',
      'RECEIVABLE_OPENED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(SESSION_SERVER_EVENTS.GRACE_ENTERED).toBe('grace_entered');
    expect(SESSION_SERVER_EVENTS.GRACE_CEILING_HIT).toBe('grace_ceiling_hit');
    expect(SESSION_SERVER_EVENTS.SESSION_SETTLED).toBe('session_settled');
    expect(SESSION_SERVER_EVENTS.RECEIVABLE_OPENED).toBe('receivable_opened');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(SESSION_SERVER_EVENTS)) {
      expect(value).toMatch(SNAKE_CASE);
    }
  });
});
