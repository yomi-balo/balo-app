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
    requestedByLabel: 'Dana @ Northwind Industrial',
    expertPartyLabel: 'CloudPeak',
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  });

  /**
   * B2 (fix round 2) — the component takes `requestedByLabel` PRE-COMPOSED (by the resolver)
   * and renders it verbatim; it does no `personWithOrgLabel` computation of its own.
   *
   * B3 (fix round 2) — every line is LITERALLY TRUE: nothing was written, so the copy never
   * claims a time was "held" or a booking is "waiting". The pill never claims to be "from your
   * team" — this is a Balo notice ABOUT a teammate's attempt.
   */
  it('renders the setup-step copy — labelled first mention, no false reservation claim, no urgency', async () => {
    const html = clean(await render(BookingFundingBlockedEmail(props())));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain("A booking couldn't go through");
    expect(html).toContain(
      'Dana @ Northwind Industrial tried to book a consultation with CloudPeak'
    );
    expect(html).toContain('The time is still open to anyone');
    expect(html).toContain('Set up billing');
    expect(html).toContain(`${BASE}/settings/billing`);
    // B3 — never implies a pending reservation, and never misattributes the notice to the team.
    expect(html).not.toMatch(/waiting|is held|has been held|from your team/i);
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
  it('subject and body reuse the resolver-composed requestedByLabel verbatim (never a second personWithOrgLabel call)', async () => {
    const out = getEmailTemplate('booking-funding-blocked', {
      recipientName: 'Sam',
      requestedByLabel: 'Dana @ Northwind Industrial',
      expertPartyLabel: 'CloudPeak',
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
  it('returns title/body/actionUrl reusing requestedByLabel verbatim, and carries no money figure', () => {
    const out = getInAppTemplate('booking-funding-blocked', {
      requestedByLabel: 'Dana @ Northwind Industrial',
      expertPartyLabel: 'CloudPeak',
    });
    expect(out.title).toBe("A booking couldn't go through");
    expect(out.body).toBe(
      "Dana @ Northwind Industrial tried to book a consultation with CloudPeak, but it couldn't go through. Add a payment method or top up and your team can book right away."
    );
    expect(out.actionUrl).toBe('/settings/billing');
    expect(out.body).not.toMatch(/\$/);
    expect(out.body).not.toMatch(/waiting|is held|has been held/i);
  });

  it('degrades to placeholders on empty data, without throwing', () => {
    const out = getInAppTemplate('booking-funding-blocked', {});
    expect(out.title).toBe("A booking couldn't go through");
    expect(out.body).toContain('A teammate tried to book a consultation with an expert');
  });
});
