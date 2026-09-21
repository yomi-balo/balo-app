import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { BookingFundingBlockedEmail } from './booking-funding-blocked.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

/** Same normalisation as `credit-topup.test.ts` — strips React-Email's interpolation markers. */
function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

describe('BookingFundingBlockedEmail (BAL-478)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Sam',
    requestedByName: 'Dana',
    companyName: 'Northwind Industrial',
    expertPartyLabel: 'CloudPeak',
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  });

  /**
   * UX-1 (fix round) — the BODY's first mention is retrospective copy and must carry the SAME
   * "@ company" label the subject already applies (`getEmailTemplate` test below), matching the
   * `credit-saved-card-detached` F4 precedent. A bare name here was the defect.
   */
  it('renders the setup-step copy — labelled first mention, no money figure, no urgency', async () => {
    const html = clean(await render(BookingFundingBlockedEmail(props())));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain('A booking is waiting on billing');
    expect(html).toContain(
      'Dana @ Northwind Industrial went to book a consultation with CloudPeak'
    );
    expect(html).toContain('Set up billing');
    expect(html).toContain(`${BASE}/settings/billing`);
  });

  it('degrades to the bare name when no company name is known (personWithOrgLabel collapse)', async () => {
    const html = clean(await render(BookingFundingBlockedEmail(props({ companyName: undefined }))));
    expect(html).toContain('Dana went to book a consultation with CloudPeak');
    expect(html).not.toContain('Dana @');
  });

  it('carries no money figure and no dunning/urgency language', async () => {
    const html = clean(await render(BookingFundingBlockedEmail(props())));
    // ⚠ `\$\d` (a dollar sign immediately followed by a digit), NOT a bare `\$` — React Email
    // itself emits `<!--$-->` / `<!--/$-->` Suspense boundary markers in the raw HTML, which a
    // bare `\$` check flags as a false positive with no money involved.
    expect(html).not.toMatch(/\$\d|balance|shortfall|amount|overdue/i);
    expect(html).not.toMatch(/urgent|immediately|deadline|hurry|act now|right now/i);
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

describe('getEmailTemplate — booking-funding-blocked factory', () => {
  it('subject uses the labelled "@ company" form (F4 precedent)', async () => {
    const out = getEmailTemplate('booking-funding-blocked', {
      recipientName: 'Sam',
      requestedByName: 'Dana',
      expertPartyLabel: 'CloudPeak',
      company: { name: 'Northwind Industrial' },
    });
    expect(out.subject).toBe('Dana @ Northwind Industrial needs billing set up to book');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain('CloudPeak');
    expect(html).not.toMatch(/\$\d/);
  });

  it('degrades to placeholders on empty data, without throwing', async () => {
    const out = getEmailTemplate('booking-funding-blocked', {});
    expect(out.subject).toBe('A teammate needs billing set up to book');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
    expect(html).toContain('an expert');
  });
});

describe('getInAppTemplate — booking-funding-blocked factory', () => {
  it('returns title/body/actionUrl with the labelled first mention, and carries no money figure', () => {
    const out = getInAppTemplate('booking-funding-blocked', {
      requestedByName: 'Dana',
      expertPartyLabel: 'CloudPeak',
      company: { name: 'Northwind Industrial' },
    });
    expect(out.title).toBe('A booking is waiting on billing');
    expect(out.body).toBe(
      'Dana @ Northwind Industrial went to book a consultation with CloudPeak. Add a payment method or top up and they can pick a time.'
    );
    expect(out.actionUrl).toBe('/settings/billing');
    expect(out.body).not.toMatch(/\$/);
  });

  it('degrades to the bare name when no company name is known', () => {
    const out = getInAppTemplate('booking-funding-blocked', {
      requestedByName: 'Dana',
      expertPartyLabel: 'CloudPeak',
    });
    expect(out.body).toContain('Dana went to book a consultation with CloudPeak.');
    expect(out.body).not.toContain('Dana @');
  });

  it('degrades to placeholders on empty data, without throwing', () => {
    const out = getInAppTemplate('booking-funding-blocked', {});
    expect(out.title).toBe('A booking is waiting on billing');
    expect(out.body).toContain('A teammate went to book a consultation with an expert.');
  });
});
