import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import {
  PartyDomainAddedEmail,
  PartyDomainRemovedEmail,
  partyDomainsPath,
} from './party-domain-ownership.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';
const data = {
  partyType: 'company',
  partyName: 'Northwind Industrial',
  domain: 'northwind.co.nz',
  recipientName: 'Dana',
};

describe('partyDomainsPath', () => {
  it('maps company to team settings and agency to the domains tab (bare settings on removal)', () => {
    expect(partyDomainsPath('company', 'added')).toBe('/settings/team');
    expect(partyDomainsPath('company', 'removed')).toBe('/settings/team');
    expect(partyDomainsPath('agency', 'added')).toBe('/expert/settings?tab=domains');
    expect(partyDomainsPath('agency', 'removed')).toBe('/expert/settings');
  });
});

describe('party domain ownership emails render', () => {
  const props = {
    firstName: 'Dana',
    partyName: 'Northwind Industrial',
    domain: 'northwind.co.nz',
    domainsUrl: `${BASE}/settings/team`,
    baseUrl: BASE,
  };

  it('added email carries the copy and the CTA', async () => {
    const html = await render(PartyDomainAddedEmail(props));
    expect(html).toContain(
      'New teammates with a northwind.co.nz email can now join, based on your join setting.'
    );
    expect(html).toContain('View domains');
    expect(html).toContain('/settings/team');
  });

  it('agency added email keeps the unconditional join copy', async () => {
    const html = await render(PartyDomainAddedEmail({ ...props, partyType: 'agency' }));
    expect(html).toContain('New teammates with a northwind.co.nz email can now join.');
    expect(html).not.toContain('based on your join setting');
  });

  it('removed email carries the copy', async () => {
    const html = await render(PartyDomainRemovedEmail(props));
    expect(html).toContain('northwind.co.nz is no longer linked to Northwind Industrial.');
    expect(html).toContain('won&#x27;t join Northwind Industrial');
  });
});

describe('getEmailTemplate — party domain events', () => {
  it('added email body carries the join-setting caveat for a company only', async () => {
    const company = await render(getEmailTemplate('party-domain-added', data).component);
    expect(company).toContain('based on your join setting.');
    const agency = await render(
      getEmailTemplate('party-domain-added', { ...data, partyType: 'agency' }).component
    );
    expect(agency).not.toContain('based on your join setting');
  });

  it('added subject names the domain and party', () => {
    expect(getEmailTemplate('party-domain-added', data).subject).toBe(
      "We've added northwind.co.nz to Northwind Industrial"
    );
  });

  it('removed subject names the domain and party', () => {
    expect(getEmailTemplate('party-domain-removed', data).subject).toBe(
      'northwind.co.nz is no longer linked to Northwind Industrial'
    );
  });

  it('strips control characters from the subject', () => {
    const { subject } = getEmailTemplate('party-domain-added', {
      ...data,
      partyName: 'Acme\r\nBcc: x@evil.com',
    });
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('company CTA links to team settings, agency CTA to the domains tab or bare settings on removal', async () => {
    const company = await render(getEmailTemplate('party-domain-added', data).component);
    expect(company).toContain('/settings/team');
    const agency = await render(
      getEmailTemplate('party-domain-removed', { ...data, partyType: 'agency' }).component
    );
    expect(agency).toContain('/expert/settings"');
    expect(agency).not.toContain('tab=domains');
    const agencyAdded = await render(
      getEmailTemplate('party-domain-added', { ...data, partyType: 'agency' }).component
    );
    expect(agencyAdded).toContain('/expert/settings?tab=domains');
  });

  it('falls back to neutral copy when the snapshot is missing', () => {
    expect(getEmailTemplate('party-domain-added', {}).subject).toBe(
      "We've added A domain to your organization"
    );
  });
});

describe('getInAppTemplate — party domain events', () => {
  it('added', () => {
    expect(getInAppTemplate('party-domain-added', data)).toEqual({
      title: 'Domain added',
      body: "We've added northwind.co.nz to Northwind Industrial. New teammates with a northwind.co.nz email can now join, based on your join setting.",
      actionUrl: '/settings/team',
    });
  });

  it('added, agency body keeps the unconditional join copy', () => {
    expect(getInAppTemplate('party-domain-added', { ...data, partyType: 'agency' }).body).toBe(
      "We've added northwind.co.nz to Northwind Industrial. New teammates with a northwind.co.nz email can now join."
    );
  });

  it('removed, agency deep link', () => {
    expect(getInAppTemplate('party-domain-removed', { ...data, partyType: 'agency' })).toEqual({
      title: 'Domain removed',
      body: "northwind.co.nz is no longer linked to Northwind Industrial. New signups with a northwind.co.nz email won't join Northwind Industrial.",
      actionUrl: '/expert/settings',
    });
  });

  it('added, agency deep link keeps the domains tab', () => {
    expect(getInAppTemplate('party-domain-added', { ...data, partyType: 'agency' }).actionUrl).toBe(
      '/expert/settings?tab=domains'
    );
  });

  it('degrades to neutral copy on a sparse payload', () => {
    expect(getInAppTemplate('party-domain-added', {}).body).toContain('your organization');
  });
});
