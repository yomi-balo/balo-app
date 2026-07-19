import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CreditTopupCompletedEmail } from './credit-topup-completed.js';
import { CreditTopupRequestedEmail } from './credit-topup-requested.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

/**
 * Normalise React-Email output: strip the `<!-- -->` markers it inserts around
 * interpolated text, and un-escape `&amp;`/`&#x27;` so copy assertions read naturally.
 */
function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

// ── CreditTopupCompletedEmail (component) ────────────────────────────────────
describe('CreditTopupCompletedEmail (BAL-377)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Priya',
    credited: 'A$100.00',
    charged: 'US$65.00',
    showCharged: true,
    promoBonus: 'A$10.00' as string | null,
    balanceAfter: 'A$110.00',
    expiryDate: '12 July 2027',
    ctaUrl: `${BASE}/experts`,
    baseUrl: BASE,
    ...over,
  });

  it('renders the success receipt copy verbatim (warm, reassurance-framed expiry)', async () => {
    const html = clean(await render(CreditTopupCompletedEmail(props())));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain('A$100.00 of credit has been added to your balance');
    expect(html).toContain('Your balance is now A$110.00.');
    expect(html).toContain(
      'It stays active until 12 July 2027 — any consultation or top-up keeps it going, so nothing is left hanging.'
    );
    expect(html).toContain('Find an expert');
    expect(html).toContain(`${BASE}/experts`);
  });

  it('shows the local-currency "charged as" line only when showCharged is true', async () => {
    const nonAud = clean(await render(CreditTopupCompletedEmail(props())));
    expect(nonAud).toContain('charged as US$65.00 in your local currency');

    const audCard = clean(
      await render(CreditTopupCompletedEmail(props({ showCharged: false, charged: 'A$100.00' })))
    );
    expect(audCard).not.toContain('in your local currency');
  });

  it('celebrates a promo bonus when present, and omits the callout when absent', async () => {
    const withPromo = clean(await render(CreditTopupCompletedEmail(props())));
    expect(withPromo).toContain('Bonus credit applied');
    expect(withPromo).toContain('A$10.00 of promo credit was added on top of your top-up.');

    const noPromo = clean(await render(CreditTopupCompletedEmail(props({ promoBonus: null }))));
    expect(noPromo).not.toContain('Bonus credit applied');
  });

  it('reveals no fee figure and no Stripe references (fee-concealment posture)', async () => {
    const html = await render(CreditTopupCompletedEmail(props()));
    expect(html).not.toMatch(/stripe|fee|markup|processing charge/i);
  });

  it('uses no countdown / urgency framing and no gendered pronouns', async () => {
    const html = await render(CreditTopupCompletedEmail(props()));
    expect(html).not.toMatch(/expires? in|deadline|last chance|hurry|act now/i);
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

// ── CreditTopupRequestedEmail (component) ────────────────────────────────────
describe('CreditTopupRequestedEmail (BAL-377 / BAL-381)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Sam',
    memberName: 'Dana',
    ctaUrl: `${BASE}/billing/top-up`,
    baseUrl: BASE,
    ...over,
  });

  it('names who asked and offers a one-click top-up (calm, non-adversarial)', async () => {
    const html = clean(await render(CreditTopupRequestedEmail(props())));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain('Dana asked for a top-up');
    expect(html).toContain('Dana let you know that your team');
    expect(html).toContain('Top up your balance');
    expect(html).toContain(`${BASE}/billing/top-up`);
  });

  it('uses no urgency framing and no gendered pronouns', async () => {
    const html = await render(CreditTopupRequestedEmail(props()));
    expect(html).not.toMatch(/urgent|immediately|deadline|hurry|act now|right now/i);
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

// ── getEmailTemplate factories (subject + formatting) ────────────────────────
describe('getEmailTemplate — credit-topup-completed factory', () => {
  it('formats the raw minor units + ISO expiry and shows the local-currency line for a non-AUD card', async () => {
    const out = getEmailTemplate('credit-topup-completed', {
      recipientName: 'Priya',
      creditedMinor: 10000,
      chargedAmountMinor: 6500,
      chargedCurrency: 'usd',
      promoGrantedMinor: 1000,
      balanceAfterMinor: 11000,
      expiresAt: '2027-07-12T00:00:00.000Z',
    });
    expect(out.subject).toBe("You're topped up — your balance is ready");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain('A$100.00 of credit has been added');
    expect(html).toContain('Your balance is now A$110.00.');
    expect(html).toContain('12 July 2027');
    expect(html).toContain('in your local currency');
    expect(html).toContain('Bonus credit applied');
    expect(html).toContain('Find an expert');
  });

  it('hides the local-currency line and the promo callout for an AUD card with no bonus', async () => {
    const out = getEmailTemplate('credit-topup-completed', {
      recipientName: 'Priya',
      creditedMinor: 5000,
      chargedAmountMinor: 5000,
      chargedCurrency: 'aud',
      promoGrantedMinor: 0,
      balanceAfterMinor: 5000,
      expiresAt: '2027-07-12T00:00:00.000Z',
    });
    const html = clean(await render(out.component));
    expect(html).not.toContain('in your local currency');
    expect(html).not.toContain('Bonus credit applied');
  });

  it('greets "there" for a name-less recipient', async () => {
    const out = getEmailTemplate('credit-topup-completed', {
      creditedMinor: 5000,
      balanceAfterMinor: 5000,
      expiresAt: '2027-07-12T00:00:00.000Z',
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });
});

describe('getEmailTemplate — credit-topup-requested factory', () => {
  it('names the requester in the subject and body', async () => {
    const out = getEmailTemplate('credit-topup-requested', {
      recipientName: 'Sam',
      requesterName: 'Dana',
    });
    expect(out.subject).toBe("Dana asked you to top up your team's balance");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain('Dana asked for a top-up');
    expect(html).toContain('/billing/top-up');
  });

  it('falls back to "A teammate" / "there" when names are absent', async () => {
    const out = getEmailTemplate('credit-topup-requested', {});
    expect(out.subject).toBe("A teammate asked you to top up your team's balance");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
    expect(html).toContain('A teammate asked for a top-up');
  });
});
