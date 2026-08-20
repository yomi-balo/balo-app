import { describe, it, expect } from 'vitest';
import { AVAILABILITY_EVENTS, AVAILABILITY_SERVER_EVENTS } from './availability';

describe('AVAILABILITY_EVENTS', () => {
  /**
   * ⚠ Sorted, so the assertion is order-independent. Two tickets (BAL-416, BAL-236) added
   * members to this family in parallel; an insertion-order assertion would break on a merge
   * for no behavioural reason.
   */
  it('exposes exactly the availability CLIENT events (guards against accidental drift)', () => {
    expect(Object.keys(AVAILABILITY_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'CALENDAR_VIEWED',
      'DURATION_FILTER_USED',
      'EMPTY_STATE_SHOWN',
      'OVERRIDE_CONFLICT_DETECTED',
      'OVERRIDE_CONFLICT_RESOLVED',
      'SLOT_SELECTED',
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

  it('maps the four BAL-236 slot-picker events to their exact snake_case values', () => {
    expect(AVAILABILITY_EVENTS.CALENDAR_VIEWED).toBe('availability_calendar_viewed');
    expect(AVAILABILITY_EVENTS.SLOT_SELECTED).toBe('availability_slot_selected');
    expect(AVAILABILITY_EVENTS.DURATION_FILTER_USED).toBe('availability_duration_filter_used');
    expect(AVAILABILITY_EVENTS.EMPTY_STATE_SHOWN).toBe('availability_empty_state_shown');
  });

  it('uses snake_case event values throughout', () => {
    for (const value of Object.values(AVAILABILITY_EVENTS)) {
      expect(value).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });

  /**
   * ⚠ The CLIENT family must never emit either SERVER wire name. Originally a guard against
   * shadowing `CALENDAR_SERVER_EVENTS` (BAL-236 D11); BAL-416 then moved those two values into
   * `AVAILABILITY_SERVER_EVENTS` in this same file, which makes the guard MORE necessary, not
   * less — the two families now sit side by side and a copy-paste between them would be silent.
   */
  it('does not collide with the SERVER family wire names', () => {
    const clientValues = Object.values(AVAILABILITY_EVENTS) as string[];
    for (const serverValue of Object.values(AVAILABILITY_SERVER_EVENTS)) {
      expect(clientValues).not.toContain(serverValue);
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
