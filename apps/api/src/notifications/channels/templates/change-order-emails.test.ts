import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import type { ReactElement } from 'react';
import { getEmailTemplate } from './index.js';

const BASE = 'https://balo.expert';
const ENGAGEMENT_ID = 'eng-1';
const CTA = `${BASE}/engagements/${ENGAGEMENT_ID}`;

const base = {
  recipientName: 'Priya',
  engagementId: ENGAGEMENT_ID,
  changeOrderId: 'co-1',
  projectTitle: 'CPQ implementation',
};

async function renderTemplate(
  name: string,
  data: Record<string, unknown>
): Promise<{ html: string; subject: string }> {
  const { component, subject } = getEmailTemplate(name, { ...base, ...data });
  const html = (await render(component as ReactElement)).replaceAll('<!-- -->', '');
  return { html, subject };
}

describe('change-order emails (BAL-622)', () => {
  it('requested-expert: person-named subject, note verbatim, CTA', async () => {
    const { html, subject } = await renderTemplate('change-order-requested-expert', {
      actorClientLabel: 'Dana @ Northwind',
      note: 'Can we add a Q4 totals report?',
    });
    expect(subject).toBe('Dana @ Northwind asked for a change to CPQ implementation');
    expect(html).toContain('Can we add a Q4 totals report?');
    expect(html).toContain('Propose a change if it affects scope or price');
    expect(html).toContain('Open the project');
    expect(html).toContain(CTA);
  });

  it('sent-client: counts, client price label, approval promise, CTA', async () => {
    const { html, subject } = await renderTemplate('change-order-sent-client', {
      actorExpertLabel: 'Charles @ CloudPeak',
      summary: 'Adds the Q4 report and trims the data load.',
      linesAdded: 1,
      linesEdited: 2,
      linesRemoved: 0,
      clientPriceChangeLabel: 'A$15,625 → A$18,125 (+A$2,500)',
    });
    expect(subject).toBe('Charles @ CloudPeak proposed a change to CPQ implementation');
    expect(html).toContain('Adds the Q4 report and trims the data load.');
    expect(html).toMatch(/1 added[\s\S]*2 edited[\s\S]*0 removed/);
    expect(html).toContain('A$15,625');
    expect(html).toContain('Nothing changes unless you approve it.');
    expect(html).toContain('Approved changes are settled on your final invoice.');
    expect(html).toContain('Review the change');
    expect(html).toContain(CTA);
  });

  it('sent-client: falls back to the estimate label on time and materials', async () => {
    const { html } = await renderTemplate('change-order-sent-client', {
      actorExpertLabel: 'Charles @ CloudPeak',
      summary: 'More hours.',
      linesAdded: 0,
      linesEdited: 1,
      linesRemoved: 0,
      estimateChangeLabel: '56 hrs → 66 hrs (+10 hrs)',
    });
    expect(html).toContain('56 hrs');
  });

  it('approved-expert: party-named subject, warm body, expert label', async () => {
    const { html, subject } = await renderTemplate('change-order-approved-expert', {
      actorClientLabel: 'Dana @ Northwind',
      clientCompanyName: 'Northwind',
      approvedOn: '15 Oct',
      expertPriceChangeLabel: 'A$12,500 → A$14,000',
    });
    expect(subject).toBe('Dana @ Northwind approved your change to CPQ implementation');
    expect(html).toContain('Dana @ Northwind');
    expect(html).toContain('on 15 Oct');
    expect(html).toContain('the difference is settled at the end of the project');
    expect(html).toContain('A$12,500');
  });

  it('approved-expert: T&M says estimates, and the cap only when it moved', async () => {
    const base = {
      actorClientLabel: 'Dana @ Northwind',
      clientCompanyName: 'Northwind',
      approvedOn: '15 Oct',
      pricingMethod: 'tm',
    };
    const plain = await renderTemplate('change-order-approved-expert', base);
    expect(plain.html).toContain('The plan and estimates are updated.');
    expect(plain.html).not.toContain('and price are updated');
    const capped = await renderTemplate('change-order-approved-expert', {
      ...base,
      expertPriceChangeLabel: 'Cap A$10,000 → A$12,000',
    });
    expect(capped.html).toContain('The plan, estimates and cap are updated.');
  });

  it('approved-admin: renders no amounts and links to the engagement', async () => {
    const { html, subject } = await renderTemplate('change-order-approved-admin', {
      actorClientLabel: 'Dana @ Northwind',
      expertPartyLabel: 'CloudPeak',
      expertPriceChangeLabel: 'A$12,500 → A$14,000',
      clientPriceChangeLabel: 'A$15,625 → A$18,125',
      estimateChangeLabel: '56 hrs → 66 hrs',
    });
    expect(subject).toBe('Change approved on CPQ implementation');
    expect(html).toContain('Dana @ Northwind approved a change from CloudPeak');
    expect(html).toContain('Figures are on the project page.');
    expect(html).not.toContain('A$');
    expect(html).not.toContain('hrs');
    expect(html).toContain(CTA);
  });

  it('declined-expert: reason verbatim and the next step', async () => {
    const { html, subject } = await renderTemplate('change-order-declined-expert', {
      actorClientLabel: 'Dana @ Northwind',
      reason: 'Out of budget this quarter.',
    });
    expect(subject).toBe('Dana @ Northwind declined the change to CPQ implementation');
    expect(html).toContain('Out of budget this quarter.');
    expect(html).toContain('You can propose a different change from the project page.');
  });

  it('answered-client: answer verbatim, nothing changed', async () => {
    const { html, subject } = await renderTemplate('change-order-answered-client', {
      actorExpertLabel: 'Charles @ CloudPeak',
      answer: 'That is already covered in milestone two.',
    });
    expect(subject).toBe('Charles @ CloudPeak answered your change request');
    expect(html).toContain('That is already covered in milestone two.');
    expect(html).toContain('Nothing on the project changed.');
    expect(html).toContain(CTA);
  });

  it('strips control characters from a hostile project title in the subject', () => {
    const { subject } = getEmailTemplate('change-order-approved-admin', {
      ...base,
      projectTitle: 'Plan\r\nBcc: x@y.z',
    });
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
