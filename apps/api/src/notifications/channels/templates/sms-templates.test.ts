import { describe, it, expect } from 'vitest';
import { getSmsTemplate } from './sms-templates.js';

describe('getSmsTemplate', () => {
  it('returns correct text for booking-reminder-sms', () => {
    const result = getSmsTemplate('booking-reminder-sms', {});
    expect(result).toBe('Balo: Reminder - your consultation starts in 30 min. Join at balo.expert');
  });

  it('throws for unknown template name', () => {
    expect(() => getSmsTemplate('nonexistent', {})).toThrow('Unknown SMS template: nonexistent');
  });

  it('all registered templates produce output under 160 characters', () => {
    const templateNames = ['booking-reminder-sms'];
    const sampleData = {
      expertName: 'Alexandra Johnson',
      date: 'Mar 25 at 2:00 PM AEDT',
    };

    for (const name of templateNames) {
      const result = getSmsTemplate(name, sampleData);
      expect(result.length).toBeLessThanOrEqual(160);
    }
  });
});
