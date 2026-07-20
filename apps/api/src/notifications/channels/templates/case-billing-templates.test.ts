import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

// Fee-concealment at the TEMPLATE layer (BAL-399): a payment receipt names the client all-in +
// the expert (display), NEVER an expert earnings figure or margin; a payout notice names the
// expert's own earnings, NEVER the client charge, markup, or margin.

// The expert accrual for the same session (A$112.50) — deliberately NOT passed to the client
// template, asserted absent so the "own-side figure only" guarantee is exercised, not vacuous.
const EXPERT_EARNINGS_SENTINEL = 'A$112.50';
const CLIENT_CHARGE_SENTINEL = 'A$150.00';

describe('getEmailTemplate — payment-charged (member receipt)', () => {
  it('renders the client all-in charge + expert name, with no expert figure / margin', async () => {
    const out = getEmailTemplate('payment-charged', {
      recipientName: 'Jordan',
      expertName: 'Amara Okafor',
      amountAudMinor: 15_000,
      durationMinutes: 45,
      chargedOn: '20 July 2026',
    });
    expect(out.subject).toBe('Your session with Amara Okafor — receipt');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain(CLIENT_CHARGE_SENTINEL);
    expect(html).toContain('Amara Okafor');
    expect(html).toContain('45');
    // No counterparty (expert-earnings) figure or fee/earnings/payout concept. ("margin" is
    // deliberately NOT asserted on the raw email HTML — it collides with the CSS `margin:` prop.)
    expect(html).not.toContain(EXPERT_EARNINGS_SENTINEL);
    expect(html.toLowerCase()).not.toContain('markup');
    expect(html.toLowerCase()).not.toContain('earnings');
    expect(html.toLowerCase()).not.toContain('payout');
  });
});

describe('getEmailTemplate — payout-recorded (expert earnings)', () => {
  it('renders the expert own earnings, with no client charge / markup / margin', async () => {
    const out = getEmailTemplate('payout-recorded', {
      recipientName: 'Amara',
      amountAudMinor: 11_250,
      durationMinutes: 45,
      recordedOn: '20 July 2026',
    });
    expect(out.subject).toBe('Your session earnings are recorded');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Amara,');
    expect(html).toContain(EXPERT_EARNINGS_SENTINEL);
    expect(html).toContain('45');
    // No counterparty (client-charge) figure or markup/client concept. ("margin" is deliberately
    // NOT asserted on the raw email HTML — it collides with the CSS `margin:` property.)
    expect(html).not.toContain(CLIENT_CHARGE_SENTINEL);
    expect(html.toLowerCase()).not.toContain('markup');
    expect(html.toLowerCase()).not.toContain('client');
  });
});

describe('getInAppTemplate — case-billing notices', () => {
  it('payment-charged shows the client all-in + expert name, no expert figure', () => {
    const out = getInAppTemplate('payment-charged', {
      amountAudMinor: 15_000,
      expertName: 'Amara Okafor',
    });
    expect(out.title).toBe('Session receipt');
    expect(out.body).toContain(CLIENT_CHARGE_SENTINEL);
    expect(out.body).toContain('Amara Okafor');
    expect(out.body).not.toContain(EXPERT_EARNINGS_SENTINEL);
    expect(`${out.title} ${out.body}`.toLowerCase()).not.toContain('margin');
  });

  it('payout-recorded shows the expert own earnings, no client charge', () => {
    const out = getInAppTemplate('payout-recorded', { amountAudMinor: 11_250 });
    expect(out.title).toBe('Earnings recorded');
    expect(out.body).toContain(EXPERT_EARNINGS_SENTINEL);
    expect(out.body).not.toContain(CLIENT_CHARGE_SENTINEL);
    expect(`${out.title} ${out.body}`.toLowerCase()).not.toContain('client');
  });
});
