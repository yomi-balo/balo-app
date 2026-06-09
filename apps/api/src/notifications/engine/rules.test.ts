import { describe, it, expect } from 'vitest';
import { notificationRules } from './rules.js';

describe('notificationRules', () => {
  it('has rules for user.welcome event', () => {
    const rules = notificationRules['user.welcome'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
  });

  it('user.welcome rule has correct config', () => {
    const [rule] = notificationRules['user.welcome']!;
    expect(rule.channel).toBe('email');
    expect(rule.recipient).toBe('self');
    expect(rule.template).toBe('welcome');
    expect(rule.timing).toBe('immediate');
    expect(rule.priority).toBe('critical');
  });

  it('has rules for expert.application_submitted event', () => {
    const rules = notificationRules['expert.application_submitted'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
  });

  it('expert.application_submitted rule has correct config', () => {
    const [rule] = notificationRules['expert.application_submitted']!;
    expect(rule.channel).toBe('email');
    expect(rule.recipient).toBe('self');
    expect(rule.template).toBe('application-submitted');
    expect(rule.timing).toBe('immediate');
    expect(rule.priority).toBe('critical');
  });

  it('has rules for project.request_submitted event', () => {
    const rules = notificationRules['project.request_submitted'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
  });

  it('project.request_submitted rule has correct config', () => {
    const [rule] = notificationRules['project.request_submitted']!;
    expect(rule.channel).toBe('email');
    expect(rule.recipient).toBe('expert');
    expect(rule.template).toBe('project-request-submitted');
    expect(rule.timing).toBe('immediate');
    expect(rule.priority).toBe('normal');
  });

  it('booking.confirmed has in-app rule for expert', () => {
    const rules = notificationRules['booking.confirmed'];
    expect(rules).toBeDefined();
    const inAppRule = rules!.find((r) => r.channel === 'in-app');
    expect(inAppRule).toBeDefined();
    expect(inAppRule!.recipient).toBe('expert');
    expect(inAppRule!.template).toBe('booking-confirmed');
    expect(inAppRule!.timing).toBe('immediate');
  });

  it('booking.confirmed SMS rule condition returns false when phoneVerifiedAt is not set', () => {
    const rules = notificationRules['booking.confirmed'];
    const smsRule = rules!.find((r) => r.channel === 'sms');
    expect(smsRule!.condition).toBeDefined();
    const result = smsRule!.condition!({
      event: 'booking.confirmed',
      payload: {},
      data: { user: { phoneVerifiedAt: null } },
    });
    expect(result).toBe(false);
  });

  it('booking.confirmed SMS rule condition returns true when phoneVerifiedAt is set', () => {
    const rules = notificationRules['booking.confirmed'];
    const smsRule = rules!.find((r) => r.channel === 'sms');
    const result = smsRule!.condition!({
      event: 'booking.confirmed',
      payload: {},
      data: { user: { phoneVerifiedAt: new Date().toISOString() } },
    });
    expect(result).toBe(true);
  });

  it('project.exploratory_requested has client email + in-app rules', () => {
    const rules = notificationRules['project.exploratory_requested'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(2);
    const email = rules!.find((r) => r.channel === 'email');
    expect(email).toMatchObject({
      recipient: 'client',
      template: 'project-exploratory-requested',
      timing: 'immediate',
      priority: 'normal',
    });
    const inApp = rules!.find((r) => r.channel === 'in-app');
    expect(inApp).toMatchObject({
      recipient: 'client',
      template: 'project-exploratory-requested',
      timing: 'immediate',
    });
  });

  it('project.expert_invited has a single expert email rule', () => {
    const rules = notificationRules['project.expert_invited'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
    expect(rules![0]).toMatchObject({
      channel: 'email',
      recipient: 'expert',
      template: 'project-expert-invited',
      timing: 'immediate',
      priority: 'normal',
    });
  });

  it('has rules for message.received event', () => {
    const rules = notificationRules['message.received'];
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
    expect(rules![0].channel).toBe('in-app');
    expect(rules![0].recipient).toBe('client');
    expect(rules![0].template).toBe('new-message');
  });

  it('all rules use timing immediate', () => {
    for (const [, rules] of Object.entries(notificationRules)) {
      for (const rule of rules) {
        expect(rule.timing).toBe('immediate');
      }
    }
  });

  it('all rules use a valid notification channel', () => {
    const validChannels = ['email', 'sms', 'in-app'];
    for (const [, rules] of Object.entries(notificationRules)) {
      for (const rule of rules) {
        expect(validChannels).toContain(rule.channel);
      }
    }
  });
});
