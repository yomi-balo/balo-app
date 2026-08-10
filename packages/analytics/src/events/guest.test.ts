import { describe, it, expect } from 'vitest';
import { GUEST_SERVER_EVENTS } from './guest';

describe('GUEST_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-408 guest server events', () => {
    // ⚠ THE COMPARATOR IS NOT OPTIONAL — a bare `.sort()` is a SonarCloud reliability bug
    // (implementation-defined comparator).
    //
    // ⚠ AND IT ORDERS `GUEST_INVITE_OPENED` BEFORE `GUEST_INVITED` — verified, not assumed.
    // After the shared `GUEST_INVITE` prefix the strings differ at `_` vs `D`. ICU collation
    // gives punctuation a LOWER primary weight than letters, so `_OPENED` sorts first; a
    // bare code-unit `.sort()` would put `GUEST_INVITED` first (`D` 0x44 < `_` 0x5F). The
    // list below is the `localeCompare` order — do not "correct" it.
    expect(Object.keys(GUEST_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'GUEST_ADMITTED',
      'GUEST_DENIED',
      'GUEST_INVITE_OPENED',
      'GUEST_INVITED',
      'GUEST_REMOVED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(GUEST_SERVER_EVENTS.GUEST_ADMITTED).toBe('guest_admitted');
    expect(GUEST_SERVER_EVENTS.GUEST_DENIED).toBe('guest_denied');
    expect(GUEST_SERVER_EVENTS.GUEST_INVITE_OPENED).toBe('guest_invite_opened');
    expect(GUEST_SERVER_EVENTS.GUEST_INVITED).toBe('guest_invited');
    expect(GUEST_SERVER_EVENTS.GUEST_REMOVED).toBe('guest_removed');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(GUEST_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('⚠ does NOT declare an event with no producer — `guest_joined` is BAL-132’s and `guest_converted_to_member` is BAL-345’s', () => {
    // A constant with no emitter reads as a 100% drop-off funnel step in PostHog. Both
    // shapes are documented in the module docblock so the receiving tickets add them
    // verbatim; neither may be declared here until it can actually fire.
    const values: readonly string[] = Object.values(GUEST_SERVER_EVENTS);
    expect(values).not.toContain('guest_joined');
    expect(values).not.toContain('guest_converted_to_member');
  });
});
