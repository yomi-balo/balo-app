import { describe, it, expect } from 'vitest';
import { ADMIN_CONFIG_SERVER_EVENTS } from './admin-config';

describe('ADMIN_CONFIG_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-398 platform-config server events', () => {
    expect(Object.keys(ADMIN_CONFIG_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'MIN_CONSULTATION_LENGTH_SET',
    ]);
  });

  it('maps the constant to its exact snake_case event name', () => {
    expect(ADMIN_CONFIG_SERVER_EVENTS.MIN_CONSULTATION_LENGTH_SET).toBe(
      'admin_min_consultation_length_set'
    );
  });

  it('uses the admin-prefixed snake_case convention', () => {
    // Shape-only guard (admin-prefixed, multi-segment snake_case) — deliberately NOT tied to a
    // `_set` suffix, so the first admin-config event that isn't a `_set` won't break it. The
    // exact-value assertion above is the real per-event guard.
    for (const value of Object.values(ADMIN_CONFIG_SERVER_EVENTS)) {
      expect(value).toMatch(/^admin_[a-z]+(_[a-z]+)+$/);
    }
  });
});
