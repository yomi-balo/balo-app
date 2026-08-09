import { describe, it, expect } from 'vitest';
import { MEETING_SERVER_EVENTS } from './meeting';

describe('MEETING_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-129 meeting server events', () => {
    // ⚠ THE COMPARATOR IS NOT OPTIONAL — a bare `.sort()` is a SonarCloud reliability bug.
    // ⚠ AND IT ORDERS THESE TWO OPPOSITE TO A CODE-UNIT SORT — verified, not assumed. After
    // the shared `MEETING_PROVISION` prefix the strings differ at `E` vs `_`. A bare
    // `.sort()` compares UTF-16 code units, where `E` (0x45) < `_` (0x5F), so it yields
    // `..._PROVISIONED` first. ICU collation gives punctuation a LOWER primary weight than
    // letters, so `_` < `E` and `..._PROVISION_FAILED` comes first. The list below is the
    // `localeCompare` order; do not "correct" it to the code-unit one.
    expect(Object.keys(MEETING_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'MEETING_PROVISION_FAILED',
      'MEETING_PROVISIONED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(MEETING_SERVER_EVENTS.MEETING_PROVISIONED).toBe('meeting_provisioned');
    expect(MEETING_SERVER_EVENTS.MEETING_PROVISION_FAILED).toBe('meeting_provision_failed');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(MEETING_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
