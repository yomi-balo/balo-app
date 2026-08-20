import { describe, it, expect } from 'vitest';
import { CALENDAR_SERVER_EVENTS, toCalendarEventProvider } from './calendar';

describe('CALENDAR_SERVER_EVENTS', () => {
  it('exposes exactly the calendar server events (guards against accidental drift)', () => {
    expect(Object.keys(CALENDAR_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'AVAILABILITY_CACHE_REBUILT',
      'CREDENTIALS_REVOKED',
      'DISCONNECTED',
      'OAUTH_COMPLETED',
      'OAUTH_FAILED',
      'RECONNECT_RESOLVED',
      'SUBSCRIPTION_LAPSE_DETECTED',
      'SYNC_PENDING_AUTO_RESOLVED',
    ]);
  });

  it('maps SUBSCRIPTION_LAPSE_DETECTED to its exact event name (BAL-468)', () => {
    expect(CALENDAR_SERVER_EVENTS.SUBSCRIPTION_LAPSE_DETECTED).toBe(
      'calendar_subscription_lapse_detected'
    );
  });

  // The BAL-235 date-override events MOVED to `AVAILABILITY_SERVER_EVENTS` (BAL-416) — their
  // value assertions migrated to `availability.test.ts`.

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
