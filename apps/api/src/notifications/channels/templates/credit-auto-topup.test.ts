import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CreditAutoTopupExecutedEmail } from './credit-auto-topup-executed.js';
import { CreditAutoTopupFailedEmail } from './credit-auto-topup-failed.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

/** Strip React-Email `<!-- -->` markers + un-escape entities so copy assertions read naturally. */
function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

/**
 * Visible copy only — strip tags (Sonar-safe `/<[^<>]*>/g`) + collapse whitespace. CSS `margin:`
 * and the `balo.expert` href live in tags/attributes, so a leak check must run on the rendered
 * TEXT, not the raw HTML (else `margin` / `expert` false-positive on boilerplate).
 */
function visibleText(html: string): string {
  return clean(html)
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Fee-concealment posture (invariant #1 / BAL-357): never a fee / margin / overdraft / expert figure. */
const LEAK_WORDS = /overdraft|margin|markup|expert rate|fee|commission/i;

// ── CreditAutoTopupExecutedEmail (component) ─────────────────────────────────
describe('CreditAutoTopupExecutedEmail (BAL-379)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Priya',
    reloaded: 'A$100.00',
    balanceAfter: 'A$110.00',
    expiryDate: '1 January 2028',
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  });

  it('renders the warm confirmation copy with AUD face values', async () => {
    const html = clean(await render(CreditAutoTopupExecutedEmail(props())));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain('We topped up your balance');
    expect(html).toContain('auto-top-up added A$100.00');
    expect(html).toContain('Your balance is now A$110.00');
    expect(html).toContain('stays active until 1 January 2028');
    expect(html).toContain(`${BASE}/settings/billing`);
  });

  it('leaks no fee / margin / overdraft / expert figure and no countdown', async () => {
    const html = await render(CreditAutoTopupExecutedEmail(props()));
    expect(visibleText(html)).not.toMatch(LEAK_WORDS);
    expect(html).not.toMatch(/expires? in|deadline|hurry|act now|last chance/i);
  });

  it('is gender-neutral (no gendered pronouns)', async () => {
    const html = await render(CreditAutoTopupExecutedEmail(props()));
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });

  it('drops the expiry clause when expiryDate is empty (keeps the balance sentence)', async () => {
    const html = clean(await render(CreditAutoTopupExecutedEmail(props({ expiryDate: '' }))));
    expect(html).toContain('Your balance is now A$110.00');
    expect(html).not.toContain('stays active until');
    expect(html).not.toMatch(/Invalid Date/i);
  });
});

// ── CreditAutoTopupFailedEmail (component) ───────────────────────────────────
describe('CreditAutoTopupFailedEmail (BAL-379)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Priya',
    attempted: 'A$100.00',
    reason: 'declined' as const,
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  });

  it('renders calm, non-dunning hard-decline copy (nothing owed / on hold)', async () => {
    const html = clean(await render(CreditAutoTopupFailedEmail(props())));
    expect(html).toContain('A quick card update keeps auto-top-up on');
    expect(html).toContain('tried to add A$100.00');
    expect(html).toContain('Nothing is owed and nothing is on hold');
    expect(html).toContain('Update payment');
  });

  it('renders the SCA confirmation variant', async () => {
    const html = clean(
      await render(CreditAutoTopupFailedEmail(props({ reason: 'requires_action' })))
    );
    expect(html).toContain('Confirm your card to keep auto-top-up on');
    expect(html).toContain('needs a quick confirmation');
    expect(html).toContain('Confirm your card');
  });

  it('leaks no fee / overdraft figure and uses no dunning / countdown language', async () => {
    const html = await render(CreditAutoTopupFailedEmail(props()));
    expect(visibleText(html)).not.toMatch(LEAK_WORDS);
    expect(html).not.toMatch(/overdue|owed to us|collection|deadline|hurry|act now|last chance/i);
  });
});

// ── getEmailTemplate factories (subject + formatting) ────────────────────────
describe('getEmailTemplate — credit-auto-topup-executed factory', () => {
  it('formats the AUD face values + ISO expiry and sets the executed subject', async () => {
    const out = getEmailTemplate('credit-auto-topup-executed', {
      recipientName: 'Priya',
      reloadedMinor: 10_000,
      balanceAfterMinor: 11_000,
      expiresAt: '2028-01-01T00:00:00.000Z',
    });
    expect(out.subject).toBe("Auto-top-up complete — your team's balance is topped up");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain('A$100.00');
    expect(html).toContain('A$110.00');
    expect(html).toContain('1 January 2028');
    expect(visibleText(html)).not.toMatch(LEAK_WORDS);
  });

  it('greets "there" for a name-less recipient', async () => {
    const out = getEmailTemplate('credit-auto-topup-executed', {
      reloadedMinor: 10_000,
      balanceAfterMinor: 11_000,
      expiresAt: '2028-01-01T00:00:00.000Z',
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });

  it('drops the expiry clause when expiresAt is empty (no "Invalid Date")', async () => {
    const out = getEmailTemplate('credit-auto-topup-executed', {
      recipientName: 'Priya',
      reloadedMinor: 10_000,
      balanceAfterMinor: 11_000,
      expiresAt: '',
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Your balance is now A$110.00');
    expect(html).not.toContain('stays active until');
    expect(html).not.toMatch(/Invalid Date|the expiry date/i);
  });
});

describe('getEmailTemplate — credit-auto-topup-failed factory', () => {
  it('sets the hard-decline subject + formats the attempted amount', async () => {
    const out = getEmailTemplate('credit-auto-topup-failed', {
      recipientName: 'Priya',
      attemptedMinor: 10_000,
      reason: 'declined',
    });
    expect(out.subject).toBe('A quick card update keeps auto-top-up on');
    const html = clean(await render(out.component));
    expect(html).toContain('tried to add A$100.00');
    expect(visibleText(html)).not.toMatch(LEAK_WORDS);
  });

  it('sets the SCA subject for reason=requires_action', () => {
    const out = getEmailTemplate('credit-auto-topup-failed', {
      attemptedMinor: 10_000,
      reason: 'requires_action',
    });
    expect(out.subject).toBe('Confirm your card to keep auto-top-up on');
  });
});

// ── getInAppTemplate (both arms + fee non-leak) ──────────────────────────────
describe('getInAppTemplate — credit auto-top-up', () => {
  it('executed: warm confirmation with AUD face values, no leak', () => {
    const out = getInAppTemplate('credit-auto-topup-executed', {
      reloadedMinor: 10_000,
      balanceAfterMinor: 11_000,
    });
    expect(out.title).toBe('Auto-top-up complete');
    expect(out.body).toContain('A$100.00');
    expect(out.body).toContain('A$110.00');
    expect(out.actionUrl).toBe('/settings/billing');
    expect(`${out.title} ${out.body}`).not.toMatch(LEAK_WORDS);
  });

  it('failed (declined): calm, nothing owed/on hold', () => {
    const out = getInAppTemplate('credit-auto-topup-failed', {
      attemptedMinor: 10_000,
      reason: 'declined',
    });
    expect(out.title).toBe('A quick card update keeps auto-top-up on');
    expect(out.body).toContain('A$100.00');
    expect(`${out.title} ${out.body}`).not.toMatch(LEAK_WORDS);
  });

  it('failed (requires_action): SCA confirmation copy', () => {
    const out = getInAppTemplate('credit-auto-topup-failed', {
      attemptedMinor: 10_000,
      reason: 'requires_action',
    });
    expect(out.title).toBe('Confirm your card to keep auto-top-up on');
    expect(out.body).toContain('quick confirmation');
  });
});
