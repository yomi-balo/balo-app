import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

describe('engagement-time-entry-changed templates (BAL-626)', () => {
  const base = {
    recipientName: 'Sam',
    actorExpertLabel: 'Priya @ CloudPeak',
    projectTitle: 'CPQ implementation',
    workedOnLabel: '14 Oct',
    hoursLabel: '3 hrs',
    engagementId: 'eng-1',
  };

  it('edited: email subject and body, in-app title and body', async () => {
    const data = { ...base, change: 'edited' };
    const email = getEmailTemplate('engagement-time-entry-changed', data);
    expect(email.subject).toBe('Priya @ CloudPeak changed your time entry on CPQ implementation');
    const html = await render(email.component);
    expect(html).toContain(
      'Priya @ CloudPeak changed your entry for 14 Oct to 3 hrs on CPQ implementation.'
    );
    expect(html).toContain('/engagements/eng-1');

    const inApp = getInAppTemplate('engagement-time-entry-changed', data);
    expect(inApp.title).toBe('Time entry changed');
    expect(inApp.body).toBe(
      'Priya @ CloudPeak changed your entry for 14 Oct to 3 hrs on CPQ implementation.'
    );
    expect(inApp.actionUrl).toBe('/engagements/eng-1');
  });

  it('removed: email subject and body, in-app title and body', async () => {
    const data = { ...base, change: 'removed' };
    const email = getEmailTemplate('engagement-time-entry-changed', data);
    expect(email.subject).toBe('Priya @ CloudPeak removed your time entry on CPQ implementation');
    const html = await render(email.component);
    expect(html).toContain('Priya @ CloudPeak removed your 3-hour entry for 14 Oct');

    const inApp = getInAppTemplate('engagement-time-entry-changed', data);
    expect(inApp.title).toBe('Time entry removed');
    expect(inApp.body).toBe(
      'Priya @ CloudPeak removed your 3-hour entry for 14 Oct on CPQ implementation.'
    );
  });
});
