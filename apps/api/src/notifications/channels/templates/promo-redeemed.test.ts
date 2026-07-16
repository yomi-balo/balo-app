import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { PromoRedeemedEmail } from './promo-redeemed.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

const props = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  code: 'WELCOME50',
  grantedLabel: 'A$50.00',
  companyName: 'Northwind Industrial',
  ctaUrl: `${BASE}/experts`,
  baseUrl: BASE,
  ...over,
});

/**
 * Normalise React-Email output: strip the `<!-- -->` markers it inserts around
 * interpolated text so multi-part strings ("A$50.00", "Northwind Industrial") read
 * naturally, and un-escape `&amp;` for URL assertions.
 */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&');
}

describe('PromoRedeemedEmail (BAL-383)', () => {
  it('greets by first name, names the code, the grant, and the company', async () => {
    const html = clean(await render(PromoRedeemedEmail(props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('WELCOME50');
    expect(html).toContain('A$50.00');
    expect(html).toContain('Northwind Industrial');
  });

  it('falls back to the "there" greeting for a name-less recipient', async () => {
    const html = clean(await render(PromoRedeemedEmail(props({ firstName: 'there' }))));
    expect(html).toContain('Hi there,');
  });

  it('states the Model-C hand-off (add a card later, no charge until then)', async () => {
    const html = clean(await render(PromoRedeemedEmail(props())));
    expect(html).toMatch(/add a card to keep going/i);
    expect(html).toMatch(/no charge until you choose to continue/i);
  });

  it('uses no countdown / pressure framing (warm milestone, not a deadline)', async () => {
    const html = await render(PromoRedeemedEmail(props()));
    expect(html).not.toMatch(/deadline|expires?|countdown|last chance|hurry|act now|before it/i);
  });

  it('uses no gendered pronouns', async () => {
    const html = await render(PromoRedeemedEmail(props()));
    expect(html).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
  });
});

describe('getEmailTemplate — promo-redeemed factory', () => {
  it('greets by recipientName and feeds the grant into the subject', async () => {
    const out = getEmailTemplate('promo-redeemed', {
      recipientName: 'Dana',
      code: 'WELCOME50',
      grantedLabel: 'A$50.00',
      companyName: 'Northwind Industrial',
    });
    expect(out.subject).toBe('A$50.00 in Balo credit is ready');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('WELCOME50');
    expect(html).toContain('/experts');
  });

  it('degrades gracefully when the greeting name is absent', async () => {
    const out = getEmailTemplate('promo-redeemed', {
      code: 'WELCOME50',
      grantedLabel: 'A$50.00',
      companyName: 'Northwind Industrial',
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });
});

describe('getInAppTemplate — promo-redeemed', () => {
  it('renders a warm credit-added notice deep-linked to expert search', () => {
    const out = getInAppTemplate('promo-redeemed', {
      grantedLabel: 'A$50.00',
      companyName: 'Northwind Industrial',
    });
    expect(out.title).toContain('Credit added');
    expect(out.body).toContain('A$50.00');
    expect(out.body).toContain('Northwind Industrial');
    expect(out.actionUrl).toBe('/experts');
  });
});
