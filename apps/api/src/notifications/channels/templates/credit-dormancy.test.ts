import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CreditDormancyReminderEmail } from './credit-dormancy-reminder.js';
import { CreditBalanceExpiredEmail } from './credit-balance-expired.js';
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

// ── CreditDormancyReminderEmail (component) ──────────────────────────────────
describe('CreditDormancyReminderEmail (BAL-380)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Priya',
    window: 60 as const,
    balance: 'A$347.00',
    expiryDate: '12 July 2027',
    ctaUrl: `${BASE}/experts`,
    baseUrl: BASE,
    ...over,
  });

  it('renders the 60-day copy verbatim (still-here framing, no countdown)', async () => {
    const html = clean(await render(CreditDormancyReminderEmail(props())));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain('Your balance is still here');
    expect(html).toContain(
      "It's been a little while since your last consultation. Your balance of A$347.00 is still here, ready whenever a Salesforce question comes up."
    );
    expect(html).toContain(
      'It stays available until 12 July 2027 — any consultation or top-up keeps it going.'
    );
    expect(html).toContain('Find an expert');
    expect(html).toContain(`${BASE}/experts`);
  });

  it('renders the 30-day copy verbatim (date in the heading)', async () => {
    const html = clean(await render(CreditDormancyReminderEmail(props({ window: 30 }))));
    expect(html).toContain('Your balance stays available until 12 July 2027');
    expect(html).toContain('Your Balo balance of A$347.00 is still here for you.');
    expect(html).toContain('Start a consultation');
  });

  it('uses no countdown / deadline / urgency framing (dormancy, not a deadline)', async () => {
    const html = await render(CreditDormancyReminderEmail(props()));
    expect(html).not.toMatch(
      /expires? in|deadline|countdown|last chance|hurry|act now|don't lose/i
    );
  });

  it('is gender-neutral (no gendered pronouns)', async () => {
    const html = await render(CreditDormancyReminderEmail(props({ window: 30 })));
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

// ── CreditBalanceExpiredEmail (component) ────────────────────────────────────
describe('CreditBalanceExpiredEmail (BAL-380)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Priya',
    expiryDate: '12 July 2027',
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  });

  it('renders the soft, provisional copy verbatim and offers a human', async () => {
    const html = clean(await render(CreditBalanceExpiredEmail(props())));
    expect(html).toContain('Your balance reached its expiry date');
    expect(html).toContain('Your Balo balance reached its expiry date on 12 July 2027.');
    expect(html).toContain('just reply to this email — a real person will help');
    expect(html).toContain('Add credit');
    expect(html).toContain(`${BASE}/settings/billing`);
  });

  it('shows NO balance figure (it is 0 post-expiry — date only)', async () => {
    const html = await render(CreditBalanceExpiredEmail(props()));
    expect(html).not.toMatch(/A\$\d/);
  });

  it('uses no red / alarm / countdown framing (soft tone)', async () => {
    const html = await render(CreditBalanceExpiredEmail(props()));
    expect(html).not.toMatch(/expired!|lost|forfeit|too late|deadline|hurry|act now/i);
  });
});

// ── getEmailTemplate factories (subject + formatting) ────────────────────────
describe('getEmailTemplate — credit-dormancy-reminder factory', () => {
  it('formats the raw balance + ISO expiry and picks the 60-day subject', async () => {
    const out = getEmailTemplate('credit-dormancy-reminder', {
      recipientName: 'Priya',
      window: 60,
      balanceMinor: 34700,
      expiresAt: '2027-07-12T00:00:00.000Z',
    });
    expect(out.subject).toBe('Your Balo balance is here whenever you need it');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain('A$347.00');
    expect(html).toContain('12 July 2027');
    expect(html).toContain('Find an expert');
  });

  it('picks the 30-day subject and its heading includes the formatted date', async () => {
    const out = getEmailTemplate('credit-dormancy-reminder', {
      recipientName: 'Priya',
      window: 30,
      balanceMinor: 34700,
      expiresAt: '2027-07-12T00:00:00.000Z',
    });
    expect(out.subject).toBe('A good time to put your Balo balance to use');
    const html = clean(await render(out.component));
    expect(html).toContain('Your balance stays available until 12 July 2027');
    expect(html).toContain('Start a consultation');
  });

  it('defaults to the 60-day variant when window is absent/unknown', () => {
    const out = getEmailTemplate('credit-dormancy-reminder', { balanceMinor: 0 });
    expect(out.subject).toBe('Your Balo balance is here whenever you need it');
  });
});

describe('getEmailTemplate — credit-balance-expired factory', () => {
  it('has the stable subject and formats the ISO expiry date', async () => {
    const out = getEmailTemplate('credit-balance-expired', {
      recipientName: 'Priya',
      expiresAt: '2027-07-12T00:00:00.000Z',
    });
    expect(out.subject).toBe('About your Balo balance');
    const html = clean(await render(out.component));
    expect(html).toContain('Your Balo balance reached its expiry date on 12 July 2027.');
    expect(html).toContain('/settings/billing');
  });

  it('greets "there" for a name-less recipient', async () => {
    const out = getEmailTemplate('credit-balance-expired', {
      expiresAt: '2027-07-12T00:00:00.000Z',
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });
});
