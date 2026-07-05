import { describe, it, expect } from 'vitest';
import { PROJECT_EVENTS, PROJECT_SERVER_EVENTS } from './project';

describe('PROJECT_EVENTS.BILLING_REMINDER_SENT (BAL-324)', () => {
  it('maps to the feature-prefixed snake_case event name', () => {
    expect(PROJECT_EVENTS.BILLING_REMINDER_SENT).toBe('project_billing_reminder_sent');
  });

  it('follows the {feature}_{noun}_{past_tense_verb} convention', () => {
    expect(PROJECT_EVENTS.BILLING_REMINDER_SENT).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });
});

describe('PROJECT_SERVER_EVENTS', () => {
  it('has exactly the request-access-denied server event (BAL-276)', () => {
    expect(Object.keys(PROJECT_SERVER_EVENTS)).toEqual(['REQUEST_ACCESS_DENIED']);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(PROJECT_SERVER_EVENTS)) {
      expect(value).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps the constant to its exact event name', () => {
    expect(PROJECT_SERVER_EVENTS.REQUEST_ACCESS_DENIED).toBe('project_request_access_denied');
  });
});
