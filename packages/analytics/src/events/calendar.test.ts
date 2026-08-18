import { describe, it, expect } from 'vitest';
import { CALENDAR_SERVER_EVENTS, toCalendarEventProvider } from './calendar';

describe('CALENDAR_SERVER_EVENTS', () => {
  it('exposes exactly the calendar server events (guards against accidental drift)', () => {
    expect(Object.keys(CALENDAR_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'AVAILABILITY_CACHE_REBUILT',
      'AVAILABILITY_OVERRIDE_CREATED',
      'AVAILABILITY_OVERRIDE_DELETED',
      'CREDENTIALS_REVOKED',
      'DISCONNECTED',
      'OAUTH_COMPLETED',
      'OAUTH_FAILED',
      'RECONNECT_RESOLVED',
      'SYNC_PENDING_AUTO_RESOLVED',
    ]);
  });

  it('maps the BAL-235 date-override events to their exact snake_case values', () => {
    expect(CALENDAR_SERVER_EVENTS.AVAILABILITY_OVERRIDE_CREATED).toBe(
      'availability_override_created'
    );
    expect(CALENDAR_SERVER_EVENTS.AVAILABILITY_OVERRIDE_DELETED).toBe(
      'availability_override_deleted'
    );
  });

  it('uses snake_case event values throughout', () => {
    for (const value of Object.values(CALENDAR_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });
});

describe('toCalendarEventProvider (BAL-396 §10.4)', () => {
  it('narrows the two known providers', () => {
    expect(toCalendarEventProvider('google')).toBe('google');
    expect(toCalendarEventProvider('microsoft')).toBe('microsoft');
  });

  it('degrades anything else to undefined rather than asserting', () => {
    expect(toCalendarEventProvider('office365')).toBeUndefined();
    expect(toCalendarEventProvider('')).toBeUndefined();
    expect(toCalendarEventProvider('GOOGLE')).toBeUndefined();
  });
});
