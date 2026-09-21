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
   * Fix round 3 — every line is LITERALLY TRUE AT READ TIME, not just at send time: "nothing
   * was booked, so no time was held" is a past fact, never a present-tense claim about the
   * slot's live availability (which could be false by the time a billing admin reads it). The
   * pill never claims to be "from your team". And no line PROMISES an outcome ("goes straight
   * through" / "book right away") — the gate can refuse a second attempt too, so copy describes
   * the action available ("try booking again"), never a guaranteed result.
   */
  it('renders the setup-step copy — labelled first mention, no false claims, no promised outcome', async () => {
    const html = clean(await render(BookingFundingBlockedEmail(props())));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain("A booking couldn't go through");
    expect(html).toContain(
      'Dana @ Northwind Industrial tried to book a consultation with CloudPeak'
    );
    expect(html).toContain('Nothing was booked, so no time was held');
    expect(html).toContain('your team can try booking again');
    expect(html).toContain('Set up billing');
    expect(html).toContain(`${BASE}/settings/billing`);
    // Never implies a pending reservation or a present-tense availability claim, never
    // misattributes the notice to the team, and never promises a guaranteed outcome.
    expect(html).not.toMatch(
      /waiting|is held|has been held|from your team|still open|straight through|right away|without this happening again/i
    );
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
      "Dana @ Northwind Industrial tried to book a consultation with CloudPeak, but it couldn't go through. Nothing was booked, so no time was held. Add a payment method or top up, then try booking again."
    );
    expect(out.actionUrl).toBe('/settings/billing');
    expect(out.body).not.toMatch(/\$/);
    expect(out.body).not.toMatch(
      /waiting|is held|has been held|still open|right away|without this happening again/i
    );
  });

  it('degrades to placeholders on empty data, without throwing', () => {
    const out = getInAppTemplate('booking-funding-blocked', {});
    expect(out.title).toBe("A booking couldn't go through");
    expect(out.body).toContain('A teammate tried to book a consultation with an expert');
  });
});
