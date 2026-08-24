import { describe, it, expect } from 'vitest';
import { getSmsTemplate, listSmsTemplates } from './sms-templates.js';

describe('getSmsTemplate', () => {
  it('returns correct text for booking-reminder-sms', () => {
    const result = getSmsTemplate('booking-reminder-sms', {});
    expect(result).toBe('Balo: Reminder - your consultation starts in 30 min. Join at balo.expert');
  });

  it('throws for unknown template name', () => {
    expect(() => getSmsTemplate('nonexistent', {})).toThrow('Unknown SMS template: nonexistent');
  });

  // Item 11 — iterates the REGISTERED set (`listSmsTemplates()`), never a hand-maintained
  // literal array. A frozen array silently stops covering every template added after it; this
  // now re-covers itself the moment a new entry joins `sms-templates.ts`'s registry.
  it('all registered templates produce output under 160 characters', () => {
    const templateNames = listSmsTemplates();
    expect(templateNames.length).toBeGreaterThan(0);
    const sampleData = {
      expertName: 'Alexandra Johnson',
      date: 'Mar 25 at 2:00 PM AEDT',
    };

    for (const name of templateNames) {
      const result = getSmsTemplate(name, sampleData);
      expect(result.length).toBeLessThanOrEqual(160);
    }
  });

  it('listSmsTemplates includes the new reschedule-proposal-sent-sms arm', () => {
    expect(listSmsTemplates()).toContain('reschedule-proposal-sent-sms');
  });
});
