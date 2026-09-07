import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CreditReceivableClearedEmail } from './credit-receivable-cleared.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

/**
 * BAL-535 (ADR-1040 Amendment 6 §F) — the receivable-cleared notice, all three arms: the email
 * COMPONENT, the `getEmailTemplate` factory (subject + AUD formatting + name fallback), and the
 * in-app arm. Modelled on `credit-auto-topup.test.ts`.
 *
 * ⚠ THIS FILE IS `.test.ts`, NOT `.test.tsx`, AND MUST STAY THAT WAY. `apps/api`'s vitest config
 * globs `*.test.ts` ONLY — a `.test.tsx` here never runs and reports green, which is exactly how
 * this template shipped with zero coverage in the first place. That is why every element below
 * is built with `React.createElement` rather than JSX.
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
    covered: 'A$50.00',
    balanceAfter: 'A$110.00',
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  };
}

describe('CreditReceivableClearedEmail (BAL-535)', () => {
  it('renders the warm resolution copy with both AUD face values and the CTA', async () => {
    const html = clean(await render(React.createElement(CreditReceivableClearedEmail, props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain("You're all set");
    expect(html).toContain('That balance is settled.');
    expect(html).toContain('A$50.00');
    expect(html).toContain('Your balance is now A$110.00');
    expect(html).toContain(`${BASE}/settings/billing`);
  });

  it('⚠ N5/L2 — attributes the figure to the CONSULTATIONS, never to the payment', async () => {
    const text = visibleText(
      await render(React.createElement(CreditReceivableClearedEmail, props()))
    );
    // The regression this fixes: "Your top-up covered … (A$50.00)" claimed THIS payment covered a
    // stale receivable amount, which is false after a partial top-up.
    expect(text).not.toMatch(/your top-?up covered/i);
    expect(text).toMatch(/extra time still to settle from your recent consultations/i);
    expect(text).toMatch(/covered by your balance/i);
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
  it('formats both AUD figures from the payload minors and sets the resolution subject', async () => {
    const out = getEmailTemplate('credit-receivable-cleared', {
      recipientName: 'Dana',
      clearedMinor: 5_000,
      balanceAfterMinor: 11_000,
    });
    expect(out.subject).toBe("You're all set — your account is clear");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Dana,');
    // `covered` comes from clearedMinor (the consultations' figure) …
    expect(html).toContain('A$50.00');
    // … and `balanceAfter` from the TRUE final display balance (M3).
    expect(html).toContain('Your balance is now A$110.00');
    expect(visibleText(html)).not.toMatch(LEAK_WORDS);
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
  it('is a warm "account clear" card with the balance and the billing CTA', () => {
    const out = getInAppTemplate('credit-receivable-cleared', {
      clearedMinor: 5_000,
      balanceAfterMinor: 11_000,
    });
    expect(out.title).toBe('Account clear');
    expect(out.body).toContain('A$110.00');
    expect(out.body).toContain("You're all set to book again");
    expect(out.actionUrl).toBe('/settings/billing');
  });

  it('⚠ N5/L2 — the in-app body attributes coverage to the balance, not to the payment', () => {
    const out = getInAppTemplate('credit-receivable-cleared', { balanceAfterMinor: 0 });
    expect(out.body).not.toMatch(/your top-?up covered/i);
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
