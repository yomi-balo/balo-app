import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CreditSavedCardDetachedEmail } from './credit-saved-card-detached.js';
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

// ── CreditSavedCardDetachedEmail (component) ─────────────────────────────────
describe('CreditSavedCardDetachedEmail (BAL-521 §3)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Priya',
    headline: 'Your saved card was removed',
    leadSentence: 'Your saved Visa ending 4242 was removed by your bank or card provider.',
    consequence: 'You were already on Just notify me, so nothing else changed.',
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  });

  it('renders the pre-branched copy verbatim (calm, informational, not alarming)', async () => {
    const html = clean(await render(CreditSavedCardDetachedEmail(props())));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain(
      'Your saved Visa ending 4242 was removed by your bank or card provider.'
    );
    expect(html).toContain('You were already on Just notify me, so nothing else changed.');
    expect(html).toContain('Manage billing settings');
    expect(html).toContain(`${BASE}/settings/billing`);
  });

  it('omits the consequence paragraph entirely when it is the empty string', async () => {
    const html = clean(await render(CreditSavedCardDetachedEmail(props({ consequence: '' }))));
    expect(html).not.toContain('Just notify me');
  });

  it('uses no urgency framing, no warning tone, and no gendered pronouns', async () => {
    const html = await render(CreditSavedCardDetachedEmail(props()));
    expect(html).not.toMatch(/urgent|immediately|deadline|hurry|act now|warning|alert/i);
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });

  it('reveals no money figure and no Stripe references (fee/PII-safe posture)', async () => {
    const html = await render(CreditSavedCardDetachedEmail(props()));
    expect(html).not.toMatch(/stripe|\$\d|mandate/i);
  });
});

// ── getEmailTemplate('credit-saved-card-detached', …) factory ────────────────
describe('getEmailTemplate — credit-saved-card-detached factory (BAL-521 §3)', () => {
  it('stripe_webhook + known card: subject + lead sentence name the bank/card provider', async () => {
    const out = getEmailTemplate('credit-saved-card-detached', {
      recipientName: 'Priya',
      source: 'stripe_webhook',
      cardBrand: 'visa',
      cardLast4: '4242',
      modeReconciled: false,
      previousLowBalanceMode: 'notify_only',
    });
    expect(out.subject).toBe('Your saved card was removed by your bank or card provider');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain(
      'Your saved Visa ending 4242 was removed by your bank or card provider.'
    );
    expect(html).toContain('You were already on Just notify me, so nothing else changed.');
  });

  it('stripe_webhook + unknown card degrades to the card-less lead sentence', async () => {
    const out = getEmailTemplate('credit-saved-card-detached', {
      source: 'stripe_webhook',
      modeReconciled: false,
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Your saved card was removed by your bank or card provider.');
    expect(html).not.toContain('ending');
  });

  it('user_initiated: subject AND body both lead with the "@ company" label (CLAUDE.md first-mention rule)', async () => {
    const out = getEmailTemplate('credit-saved-card-detached', {
      recipientName: 'Sam',
      source: 'user_initiated',
      detachedByName: 'Dana',
      detachedByLabel: 'Dana @ Northwind Industrial',
      cardBrand: 'mastercard',
      cardLast4: '0005',
      modeReconciled: false,
      previousLowBalanceMode: 'notify_only',
    });
    expect(out.subject).toBe("Dana @ Northwind Industrial removed your team's saved card");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain(
      'Dana @ Northwind Industrial removed the saved card — the Mastercard ending 0005.'
    );
  });

  it('user_initiated falls back to "A teammate" when no actor name resolved', async () => {
    const out = getEmailTemplate('credit-saved-card-detached', {
      source: 'user_initiated',
      modeReconciled: false,
    });
    expect(out.subject).toBe("A teammate removed your team's saved card");
    const html = clean(await render(out.component));
    expect(html).toContain('A teammate removed the saved card.');
  });

  it('the consequence sentence appears IFF modeReconciled, and names the mode that went off', async () => {
    const reconciled = getEmailTemplate('credit-saved-card-detached', {
      source: 'stripe_webhook',
      modeReconciled: true,
      previousLowBalanceMode: 'auto_topup',
    });
    const reconciledHtml = clean(await render(reconciled.component));
    expect(reconciledHtml).toContain(
      "Auto top-up is now off — you're on Just notify me. Add a card in Billing settings to turn it back on."
    );

    const keepGoing = getEmailTemplate('credit-saved-card-detached', {
      source: 'stripe_webhook',
      modeReconciled: true,
      previousLowBalanceMode: 'keep_going',
    });
    const keepGoingHtml = clean(await render(keepGoing.component));
    expect(keepGoingHtml).toContain('Keep me going is now off');

    const notReconciled = getEmailTemplate('credit-saved-card-detached', {
      source: 'stripe_webhook',
      modeReconciled: false,
    });
    const notReconciledHtml = clean(await render(notReconciled.component));
    expect(notReconciledHtml).toContain(
      'You were already on Just notify me, so nothing else changed.'
    );
    expect(notReconciledHtml).not.toContain('is now off');
  });

  it('greets "there" for a name-less recipient', async () => {
    const out = getEmailTemplate('credit-saved-card-detached', {
      source: 'stripe_webhook',
      modeReconciled: false,
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });

  it('CTA links to /settings/billing, never /billing/top-up', async () => {
    const out = getEmailTemplate('credit-saved-card-detached', {
      source: 'stripe_webhook',
      modeReconciled: false,
    });
    const html = await render(out.component);
    expect(html).toContain('/settings/billing');
    expect(html).not.toContain('/billing/top-up');
  });

  it('uses no gendered pronouns anywhere', async () => {
    const out = getEmailTemplate('credit-saved-card-detached', {
      source: 'user_initiated',
      detachedByLabel: 'Dana @ Northwind Industrial',
      modeReconciled: true,
      previousLowBalanceMode: 'auto_topup',
    });
    const html = await render(out.component);
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});
