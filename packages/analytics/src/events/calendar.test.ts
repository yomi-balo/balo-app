import { describe, it, expect } from 'vitest';
import { CALENDAR_EVENTS, CALENDAR_SERVER_EVENTS, toCalendarEventProvider } from './calendar';

describe('CALENDAR_EVENTS — the Calendar page family (BAL-498, BAL-512)', () => {
  it('pins the three BAL-498 calendar-page event values', () => {
    expect(CALENDAR_EVENTS.VIEWED).toBe('calendar_viewed');
    expect(CALENDAR_EVENTS.JOIN_CLICKED).toBe('calendar_join_clicked');
    expect(CALENDAR_EVENTS.EDIT_AVAILABILITY_CLICKED).toBe('calendar_edit_availability_clicked');
  });

  it('pins the two BAL-512 event values', () => {
    expect(CALENDAR_EVENTS.CONNECT_CTA_CLICKED).toBe('calendar_connect_cta_clicked');
    expect(CALENDAR_EVENTS.WEEK_NAVIGATED).toBe('calendar_week_navigated');
  });

  /**
   * BAL-512 — the guard BAL-498 deferred, and the mechanism the ⚠ docblocks further down this
   * module say was missing when Cronofy-era members were removed and the BAL-235 override events
   * were moved out. An added, removed or renamed member now fails HERE instead of silently
   * changing a re-export allowlist.
   *
   * ⚠ SOURCE-ORDERED, NOT SORTED — deliberately unlike the `CALENDAR_SERVER_EVENTS` guard below,
   * which sorts before comparing. The two conventions coexist on purpose (matching
   * `nav.test.ts`'s ordered tuples); do not "make them consistent" by sorting this one.
   */
  it('is exactly these 18 members, in source order', () => {
    expect(Object.keys(CALENDAR_EVENTS)).toEqual([
      'CONNECT_INITIATED',
      'DISCONNECT_INITIATED',
      'SUB_CALENDAR_TOGGLED',
      'TARGET_CALENDAR_SET',
      'FIX_PERMISSIONS_CLICKED',
      'RECONNECT_CLICKED',
      'SYNC_PENDING_RESOLVED',
      'O365_GUIDANCE_SHOWN',
      'O365_GUIDANCE_CONTINUED',
      'O365_GUIDANCE_CANCELLED',
      'O365_WAITING_TRY_AGAIN',
      'SESSION_EXPIRED_TRY_AGAIN',
      'CONNECTING_TIMEOUT',
      'VIEWED',
      'JOIN_CLICKED',
      'EDIT_AVAILABILITY_CLICKED',
      'CONNECT_CTA_CLICKED',
      'WEEK_NAVIGATED',
    ]);
  });

  it('uses snake_case event values throughout', () => {
    for (const value of Object.values(CALENDAR_EVENTS)) {
      expect(value).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });
});

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
