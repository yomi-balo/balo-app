import { describe, it, expect } from 'vitest';
import { EXPERT_EVENTS, EXPERT_SERVER_EVENTS } from './expert';

describe('EXPERT_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(EXPERT_EVENTS)).toEqual([
      'APPLICATION_STARTED',
      'APPLICATION_RESUMED',
      'APPLICATION_STEP_COMPLETED',
      'APPLICATION_STEP_SKIPPED',
      'APPLICATION_SUBMITTED',
      'APPLICATION_SUBMIT_FAILED',
      'APPLICATION_ABANDONED',
      'REFERRAL_PROMPT_VIEWED',
      'REFERRAL_INVITES_SENT',
      'ASSESSMENT_DONE_BLOCKED',
      'APPLICATION_ANONYMOUS_STARTED',
      'APPLICATION_AUTH_GATE_REACHED',
      'APPLICATION_DRAFT_FLUSHED',
    ]);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(EXPERT_EVENTS.APPLICATION_STARTED).toBe('expert_application_started');
    expect(EXPERT_EVENTS.APPLICATION_RESUMED).toBe('expert_application_resumed');
    expect(EXPERT_EVENTS.APPLICATION_STEP_COMPLETED).toBe('expert_application_step_completed');
    expect(EXPERT_EVENTS.APPLICATION_STEP_SKIPPED).toBe('expert_application_step_skipped');
    expect(EXPERT_EVENTS.APPLICATION_SUBMITTED).toBe('expert_application_submitted');
    expect(EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED).toBe('expert_application_submit_failed');
    expect(EXPERT_EVENTS.APPLICATION_ABANDONED).toBe('expert_application_abandoned');
    expect(EXPERT_EVENTS.REFERRAL_PROMPT_VIEWED).toBe('expert_referral_prompt_viewed');
    expect(EXPERT_EVENTS.REFERRAL_INVITES_SENT).toBe('expert_referral_invites_sent');
    expect(EXPERT_EVENTS.ASSESSMENT_DONE_BLOCKED).toBe(
      'expert_application_assessment_done_blocked'
    );
    expect(EXPERT_EVENTS.APPLICATION_ANONYMOUS_STARTED).toBe(
      'expert_application_anonymous_started'
    );
    expect(EXPERT_EVENTS.APPLICATION_AUTH_GATE_REACHED).toBe(
      'expert_application_auth_gate_reached'
    );
    expect(EXPERT_EVENTS.APPLICATION_DRAFT_FLUSHED).toBe('expert_application_draft_flushed');
  });

  it('values follow the naming convention expert_{noun}(_{noun})*', () => {
    for (const value of Object.values(EXPERT_EVENTS)) {
      expect(value).toMatch(/^expert_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('APPLICATION_STARTED and APPLICATION_ANONYMOUS_STARTED are distinct events (BAL-502 §22.10 — never fired together)', () => {
    expect(EXPERT_EVENTS.APPLICATION_STARTED).not.toBe(EXPERT_EVENTS.APPLICATION_ANONYMOUS_STARTED);
  });
});

describe('EXPERT_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(EXPERT_SERVER_EVENTS)).toEqual(['DRAFT_SAVED', 'DRAFT_SAVE_FAILED']);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(EXPERT_SERVER_EVENTS.DRAFT_SAVED).toBe('expert_application_draft_saved');
    expect(EXPERT_SERVER_EVENTS.DRAFT_SAVE_FAILED).toBe('expert_application_draft_save_failed');
  });

  it('values follow the naming convention expert_{noun}(_{noun})*', () => {
    for (const value of Object.values(EXPERT_SERVER_EVENTS)) {
      expect(value).toMatch(/^expert_[a-z]+(_[a-z]+)*$/);
    }
  });
});
