import { describe, it, expect } from 'vitest';
import { ADMIN_CAPTURE_HEALTH_EVENTS } from './admin-capture-health';

describe('ADMIN_CAPTURE_HEALTH_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(ADMIN_CAPTURE_HEALTH_EVENTS)).toEqual(['VIEWED', 'REDRIVE_REQUESTED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(ADMIN_CAPTURE_HEALTH_EVENTS.VIEWED).toBe('admin_capture_health_viewed');
    expect(ADMIN_CAPTURE_HEALTH_EVENTS.REDRIVE_REQUESTED).toBe('admin_redrive_requested');
  });

  /**
   * ⚠ THE `admin_[a-z]+(_[a-z]+)*` SHAPE (`admin-alerts.test.ts`'s convention), NOT a
   * `^admin_capture_health_` prefix guard — `admin_redrive_requested` would fail a
   * namespace-prefixed guard (memory `reference_analytics_registration_is_five_files`: check
   * the namespace's actual guard before accepting a ticket's literal event name).
   */
  it('values follow the naming convention {feature}_{noun}_{past_tense_verb}', () => {
    for (const value of Object.values(ADMIN_CAPTURE_HEALTH_EVENTS)) {
      expect(value).toMatch(/^admin_[a-z]+(_[a-z]+)*$/);
    }
  });
});
