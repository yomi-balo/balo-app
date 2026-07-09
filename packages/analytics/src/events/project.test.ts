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
  it('has the request-access-denied, server-emitted proposal, and admin-fee events (BAL-276 / BAL-357 / BAL-358)', () => {
    expect(Object.keys(PROJECT_SERVER_EVENTS)).toEqual([
      'REQUEST_ACCESS_DENIED',
      'PROJECT_PROPOSAL_SUBMITTED',
      'PROJECT_PROPOSAL_ACCEPTED',
      'ADMIN_PROJECT_FEE_OVERRIDDEN',
    ]);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    // Values carry a feature prefix (`project_` for participant events, `admin_` for
    // the admin-audience fee override) — assert snake_case shape across all.
    for (const value of Object.values(PROJECT_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps the constants to their exact event names', () => {
    expect(PROJECT_SERVER_EVENTS.REQUEST_ACCESS_DENIED).toBe('project_request_access_denied');
    // BAL-357: kept identical to the former client-event values for analytics continuity.
    expect(PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_SUBMITTED).toBe('project_proposal_submitted');
    expect(PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_ACCEPTED).toBe('project_proposal_accepted');
    // BAL-358: the admin per-project fee override (admin-audience feature prefix).
    expect(PROJECT_SERVER_EVENTS.ADMIN_PROJECT_FEE_OVERRIDDEN).toBe('admin_project_fee_overridden');
  });
});
