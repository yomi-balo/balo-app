import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import {
  PartyMemberJoinedViaDomainEmail,
  PartyJoinRequestCreatedEmail,
  PartyJoinRequestApprovedEmail,
  PartyJoinRequestDeclinedEmail,
} from './party-domain-join.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

describe('party-domain-join email components render', () => {
  it('renders the member-joined email naming the actor + party', async () => {
    const html = await render(
      PartyMemberJoinedViaDomainEmail({
        firstName: 'Admin',
        actorName: 'Jo Iner',
        partyNoun: 'company',
        teamUrl: `${BASE}/settings/team`,
        baseUrl: BASE,
      })
    );
    expect(html).toContain('Jo Iner');
    expect(html).toContain('company');
  });

  it('renders the request-created email with a review CTA', async () => {
    const html = await render(
      PartyJoinRequestCreatedEmail({
        firstName: 'Admin',
        actorName: 'Jo Iner',
        partyNoun: 'company',
        teamUrl: `${BASE}/settings/team`,
        baseUrl: BASE,
      })
    );
    expect(html).toContain('Jo Iner');
    expect(html).toContain('/settings/team');
  });

  it('renders the approved + declined requester emails', async () => {
    const approved = await render(
      PartyJoinRequestApprovedEmail({
        firstName: 'Jo',
        partyNoun: 'company',
        teamUrl: `${BASE}/dashboard`,
        baseUrl: BASE,
      })
    );
    expect(approved).toContain('approved');

    const declined = await render(
      PartyJoinRequestDeclinedEmail({ firstName: 'Jo', partyNoun: 'company', baseUrl: BASE })
    );
    expect(declined).toContain('not approved');
  });
});

describe('getEmailTemplate — BAL-345 factories', () => {
  const data = {
    user: { firstName: 'Jo', lastName: 'Iner' },
    partyType: 'company',
    recipientName: 'Admin',
  };

  it.each([
    ['party-member-joined-via-domain', 'Jo Iner joined your company'],
    ['party-join-request-created', 'Jo Iner requested to join your company'],
  ] as const)('%s → subject names the actor', (template, subject) => {
    const result = getEmailTemplate(template, data);
    expect(result.subject).toBe(subject);
    expect(result.component).toBeDefined();
  });

  it('falls back to "A teammate" when the actor has no name', () => {
    const result = getEmailTemplate('party-join-request-created', {
      partyType: 'agency',
      recipientName: 'Admin',
    });
    expect(result.subject).toBe('A teammate requested to join your agency');
  });

  it.each([
    ['party-join-request-approved', "You're in — your request to join the company was approved"],
    ['party-join-request-declined', 'An update on your request to join the company'],
  ] as const)('%s → requester-facing subject', (template, subject) => {
    const result = getEmailTemplate(template, data);
    expect(result.subject).toBe(subject);
    expect(result.component).toBeDefined();
  });
});

describe('getInAppTemplate — BAL-345 strings', () => {
  const data = { user: { firstName: 'Jo', lastName: 'Iner' }, partyType: 'company' };

  it('member-joined → names the actor, links to team', () => {
    const out = getInAppTemplate('party-member-joined-via-domain', data);
    expect(out.title).toBe('New teammate joined');
    expect(out.body).toContain('Jo Iner');
    expect(out.actionUrl).toBe('/settings/team');
  });

  it('request-created → names the actor', () => {
    const out = getInAppTemplate('party-join-request-created', data);
    expect(out.body).toContain('Jo Iner');
    expect(out.actionUrl).toBe('/settings/team');
  });

  it('approved → requester confirmation to dashboard', () => {
    const out = getInAppTemplate('party-join-request-approved', data);
    expect(out.title).toBe("You're in");
    expect(out.actionUrl).toBe('/dashboard');
  });

  it('declined → requester notice (no action url)', () => {
    const out = getInAppTemplate('party-join-request-declined', data);
    expect(out.title).toBe('Request declined');
    expect(out.actionUrl).toBeUndefined();
  });

  it('falls back to "A teammate" and "organization" when data is sparse', () => {
    const out = getInAppTemplate('party-member-joined-via-domain', {});
    expect(out.body).toContain('A teammate');
    expect(out.body).toContain('organization');
  });
});
