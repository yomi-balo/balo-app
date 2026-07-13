import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_REMINDER_SERVER_EVENTS,
  ONBOARDING_REMINDER_EVENTS,
} from './onboarding-reminder';

describe('ONBOARDING_REMINDER_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(ONBOARDING_REMINDER_SERVER_EVENTS)).toEqual(['SENT']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(ONBOARDING_REMINDER_SERVER_EVENTS.SENT).toBe('onboarding_reminder_sent');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(ONBOARDING_REMINDER_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('ONBOARDING_REMINDER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(ONBOARDING_REMINDER_EVENTS)).toEqual(['CLICKED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(ONBOARDING_REMINDER_EVENTS.CLICKED).toBe('onboarding_reminder_clicked');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(ONBOARDING_REMINDER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
