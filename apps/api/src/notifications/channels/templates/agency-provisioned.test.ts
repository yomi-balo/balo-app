import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { AgencyProvisionedEmail } from './agency-provisioned.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

describe('AgencyProvisionedEmail component (BAL-348)', () => {
  it('renders the owner-framed, prospective copy naming the team + team CTA', async () => {
    const html = await render(
      AgencyProvisionedEmail({
        firstName: 'Priya',
        teamName: 'CloudPeak Consulting',
        teamUrl: `${BASE}/settings/team`,
        baseUrl: BASE,
      })
    );
    expect(html).toContain('Priya');
    expect(html).toContain('CloudPeak Consulting');
    expect(html).toContain('join automatically');
    expect(html).toContain('transfer ownership later');
    expect(html).toContain('/settings/team');
  });
});

describe('getEmailTemplate — agency-provisioned factory (BAL-348)', () => {
  it('names the team from data.agency and points the CTA at /settings/team', () => {
    const result = getEmailTemplate('agency-provisioned', {
      agency: { id: 'agency-1', name: 'CloudPeak Consulting' },
      recipientName: 'Priya',
    });
    expect(result.subject).toBe('CloudPeak Consulting is set up on Balo');
    expect(result.component).toBeDefined();
  });

  it('falls back to "Your team" when the agency summary is absent (matches the in-app title)', () => {
    const result = getEmailTemplate('agency-provisioned', { recipientName: 'Priya' });
    expect(result.subject).toBe('Your team is set up on Balo');
    expect(result.component).toBeDefined();
  });
});

describe('getInAppTemplate — agency-provisioned (BAL-348)', () => {
  it('names the team, prospective body, deep-links to team settings', () => {
    const out = getInAppTemplate('agency-provisioned', {
      agency: { id: 'agency-1', name: 'CloudPeak Consulting' },
    });
    expect(out.title).toBe('Your team is set up');
    expect(out.body).toContain('CloudPeak Consulting');
    expect(out.body).toContain('join automatically');
    expect(out.actionUrl).toBe('/settings/team');
  });

  it('falls back to "Your team" when the agency summary is absent', () => {
    const out = getInAppTemplate('agency-provisioned', {});
    expect(out.title).toBe('Your team is set up');
    expect(out.body).toContain('Your team');
    expect(out.actionUrl).toBe('/settings/team');
  });
});
