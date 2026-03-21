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

  it('all rules use timing immediate', () => {
    for (const [, rules] of Object.entries(notificationRules)) {
      for (const rule of rules) {
        expect(rule.timing).toBe('immediate');
      }
    }
  });

  it('all rules use email channel', () => {
    for (const [, rules] of Object.entries(notificationRules)) {
      for (const rule of rules) {
        expect(rule.channel).toBe('email');
      }
    }
  });
});
