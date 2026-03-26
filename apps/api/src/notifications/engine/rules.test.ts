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

  it('booking.confirmed has in-app rule for expert', () => {
    const rules = notificationRules['booking.confirmed'];
    expect(rules).toBeDefined();
    const inAppRule = rules!.find((r) => r.channel === 'in-app');
    expect(inAppRule).toBeDefined();
    expect(inAppRule!.recipient).toBe('expert');
    expect(inAppRule!.template).toBe('booking-confirmed');
    expect(inAppRule!.timing).toBe('immediate');
  });

  it('booking.confirmed SMS rule condition returns false when smsOptedIn is not true', () => {
    const rules = notificationRules['booking.confirmed'];
    const smsRule = rules!.find((r) => r.channel === 'sms');
    expect(smsRule!.condition).toBeDefined();
    const result = smsRule!.condition!({
      event: 'booking.confirmed',
      payload: {},
      data: { user: { smsOptedIn: false } },
    });
    expect(result).toBe(false);
  });

  it('booking.confirmed SMS rule condition returns true when smsOptedIn is true', () => {
    const rules = notificationRules['booking.confirmed'];
    const smsRule = rules!.find((r) => r.channel === 'sms');
    const result = smsRule!.condition!({
      event: 'booking.confirmed',
      payload: {},
      data: { user: { smsOptedIn: true } },
    });
    expect(result).toBe(true);
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
