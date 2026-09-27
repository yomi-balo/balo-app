import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CreditReceivableClearedEmail } from './credit-receivable-cleared.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

/**
 * BAL-535 (ADR-1040 Amendment 6 §F) — the receivable-cleared notice, all three arms: the email
 * COMPONENT, the `getEmailTemplate` factory (subject + AUD formatting + name fallback), and the
 * in-app arm. Modelled on `credit-auto-topup.test.ts`. The strings are BAL-474's owner-approved
 * copy v2.1 §6, pinned verbatim.
 *
 * ⚠ THIS FILE IS `.test.ts`, NOT `.test.tsx`, AND MUST STAY THAT WAY. `apps/api`'s vitest config
 * globs `*.test.ts` ONLY — a `.test.tsx` here never runs and reports green, which is exactly how
 * this template shipped with zero coverage in the first place. That is why every element below
 * is built with `React.createElement` rather than JSX.
 *
 * ⚠ BAL-474 — the notice is sent once per write on four paths (a cash top-up, a settlement charge
 * that covers the remaining debts, a settlement charge that clears its own session's last
 * receivable, and the covered-hold correction). So it states NO amount but the balance — no
 * cleared-amount figure, no "extra time", no "nothing else to do" — and claims only that the hold
 * no longer stops new bookings: a company with no mandate can still need enough credit to book.
 */

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
 * TEXT, not the raw HTML.
 */
function visibleText(html: string): string {
  return clean(html)
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Fee-concealment posture (invariant #1 / BAL-357) + the pinned "overdraft" ban. */
const LEAK_WORDS = /overdraft|margin|markup|expert rate|fee|commission/i;

type ClearedProps = React.ComponentProps<typeof CreditReceivableClearedEmail>;

function props(over: Partial<ClearedProps> = {}): ClearedProps {
  return {
    firstName: 'Dana',
    balanceAfter: 'A$110.00',
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  };
}

describe('CreditReceivableClearedEmail (BAL-535)', () => {
  it('renders the approved resolution copy verbatim, with the balance and the CTA', async () => {
    const html = clean(await render(React.createElement(CreditReceivableClearedEmail, props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('✅ Account clear');
    expect(html).toContain("You're all set");
    expect(html).toContain('That balance is settled.');
    expect(html).toContain(
      'Your balance now covers what your consultations came to, so your account is clear. It no longer stops new bookings.'
    );
    expect(html).toContain('Your balance is now A$110.00');
    expect(html).toContain('View billing');
    expect(html).toContain(`${BASE}/settings/billing`);
    expect(html).toContain("That balance is settled — nothing's outstanding on your account");
    expect(html).toContain('Questions about your balance?');
  });

  it('⚠ BAL-474 — names no cleared amount, no "extra time" and no "nothing else to do"', async () => {
    const text = visibleText(
      await render(React.createElement(CreditReceivableClearedEmail, props()))
    );
    // The only figure is the balance: a Σ of cleared receivables is a stale snapshot.
    expect(text.match(/A\$[\d,]+\.\d{2}/g)).toEqual(['A$110.00']);
    expect(text).not.toMatch(
      /extra time|nothing else to do|still to settle|your top-?up covered|book again/i
    );
  });

  it('leaks no fee / margin / overdraft / expert figure and uses no countdown language', async () => {
    const html = await render(React.createElement(CreditReceivableClearedEmail, props()));
    expect(visibleText(html)).not.toMatch(LEAK_WORDS);
    expect(html).not.toMatch(/expires? in|deadline|hurry|act now|last chance|overdue|collection/i);
  });

  it('greets "there" when no first name is supplied (the prop default)', async () => {
    const html = clean(
      await render(
        React.createElement(CreditReceivableClearedEmail, props({ firstName: undefined }))
      )
    );
    expect(html).toContain('Hi there,');
  });
});

describe('getEmailTemplate — credit-receivable-cleared factory', () => {
  it('formats the balance from the payload minors, ignores clearedMinor, and sets the resolution subject', async () => {
    const out = getEmailTemplate('credit-receivable-cleared', {
      recipientName: 'Dana',
      clearedMinor: 5_000,
      balanceAfterMinor: 11_000,
    });
    expect(out.subject).toBe("You're all set — your account is clear");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Dana,');
    // `balanceAfter` is the TRUE final display balance (M3); `clearedMinor` is analytics-only.
    expect(html).toContain('Your balance is now A$110.00');
    expect(html).not.toContain('A$50.00');
    expect(visibleText(html)).not.toMatch(LEAK_WORDS);
    expect(html).not.toMatch(/book again|extra time|nothing else to do/i);
  });

  it('greets "there" for a name-less recipient', async () => {
    const out = getEmailTemplate('credit-receivable-cleared', {
      clearedMinor: 5_000,
      balanceAfterMinor: 11_000,
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });

  it('renders A$0.00 rather than NaN when a figure is missing from the payload', async () => {
    const out = getEmailTemplate('credit-receivable-cleared', { recipientName: 'Dana' });
    const html = clean(await render(out.component));
    expect(html).toContain('A$0.00');
    expect(html).not.toMatch(/NaN|undefined/);
  });
});

describe('getInAppTemplate — credit-receivable-cleared', () => {
  it('is a warm "account clear" card with the balance and the billing link — verbatim', () => {
    const out = getInAppTemplate('credit-receivable-cleared', {
      clearedMinor: 5_000,
      balanceAfterMinor: 11_000,
    });
    expect(out.title).toBe('Account clear');
    expect(out.body).toBe(
      'Your balance now covers what your consultations came to, so it no longer stops new bookings. Your balance is now A$110.00.'
    );
    expect(out.actionUrl).toBe('/settings/billing');
  });

  it('⚠ BAL-474 — no cleared amount, no "extra time", no "nothing else to do"', () => {
    const out = getInAppTemplate('credit-receivable-cleared', {
      clearedMinor: 5_000,
      balanceAfterMinor: 11_000,
    });
    expect(out.body).not.toContain('A$50.00');
    expect(out.body).not.toMatch(
      /extra time|nothing else to do|still to settle|nothing's outstanding|your top-?up covered|book again/i
    );
    expect(out.body).toMatch(/your balance now covers/i);
  });

  it('leaks no fee / overdraft wording', () => {
    const out = getInAppTemplate('credit-receivable-cleared', {
      clearedMinor: 5_000,
      balanceAfterMinor: 11_000,
    });
    expect(`${out.title} ${out.body}`).not.toMatch(LEAK_WORDS);
  });
});
