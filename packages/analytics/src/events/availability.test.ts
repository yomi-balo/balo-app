import { describe, it, expect } from 'vitest';
import { AVAILABILITY_EVENTS, AVAILABILITY_SERVER_EVENTS } from './availability';

describe('AVAILABILITY_EVENTS', () => {
  it('exposes exactly the availability CLIENT events (guards against accidental drift)', () => {
    expect(Object.keys(AVAILABILITY_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'OVERRIDE_CONFLICT_DETECTED',
      'OVERRIDE_CONFLICT_RESOLVED',
    ]);
  });

  it('maps the two BAL-416 client events to their exact snake_case values', () => {
    expect(AVAILABILITY_EVENTS.OVERRIDE_CONFLICT_DETECTED).toBe(
      'availability_override_conflict_detected'
    );
    expect(AVAILABILITY_EVENTS.OVERRIDE_CONFLICT_RESOLVED).toBe(
      'availability_override_conflict_resolved'
    );
  });

  it('uses snake_case event values throughout', () => {
    for (const value of Object.values(AVAILABILITY_EVENTS)) {
      expect(value).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });
});

describe('AVAILABILITY_SERVER_EVENTS', () => {
  it('exposes exactly the availability SERVER events (guards against accidental drift)', () => {
    expect(Object.keys(AVAILABILITY_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'OVERRIDE_CREATED',
      'OVERRIDE_DELETED',
    ]);
  });

  /**
   * ⚠ THE POSTHOG-CONTINUITY ASSERTION. These two values MUST stay byte-identical to what
   * `CALENDAR_SERVER_EVENTS.AVAILABILITY_OVERRIDE_CREATED` / `_DELETED` used to emit
   * (BAL-235) — the TypeScript constant's HOME moved by BAL-416, not the wire value. A
   * change here is a broken funnel / new person profile in PostHog, not a rename.
   */
  it('maps the MOVED BAL-235 events to their exact, UNCHANGED snake_case values', () => {
    expect(AVAILABILITY_SERVER_EVENTS.OVERRIDE_CREATED).toBe('availability_override_created');
    expect(AVAILABILITY_SERVER_EVENTS.OVERRIDE_DELETED).toBe('availability_override_deleted');
  });

  it('uses snake_case event values throughout', () => {
    for (const value of Object.values(AVAILABILITY_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });
});
