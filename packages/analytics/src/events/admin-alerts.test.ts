import { describe, it, expect } from 'vitest';
import { ADMIN_ALERTS_EVENTS } from './admin-alerts';

describe('ADMIN_ALERTS_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(ADMIN_ALERTS_EVENTS)).toEqual([
      'QUEUE_VIEWED',
      'ALERT_OPENED',
      'ALERT_CLOSED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(ADMIN_ALERTS_EVENTS.QUEUE_VIEWED).toBe('admin_queue_viewed');
    expect(ADMIN_ALERTS_EVENTS.ALERT_OPENED).toBe('admin_alert_opened');
    expect(ADMIN_ALERTS_EVENTS.ALERT_CLOSED).toBe('admin_alert_closed');
  });

  it('values follow the naming convention {feature}_{noun}_{past_tense_verb}', () => {
    for (const value of Object.values(ADMIN_ALERTS_EVENTS)) {
      expect(value).toMatch(/^admin_[a-z]+(_[a-z]+)*$/);
    }
  });
});
