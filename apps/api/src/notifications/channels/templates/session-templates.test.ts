import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';
import { getSmsTemplate } from './sms-templates.js';

function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

// ── Email factories (BAL-378) ────────────────────────────────────────────────
describe('getEmailTemplate — session-settled', () => {
  it('renders the settled receipt with the amount when there was extra time', async () => {
    const out = getEmailTemplate('session-settled', {
      recipientName: 'Priya',
      expertName: 'Jordan Ellis',
      overdraftSettledMinor: 1200,
      settledOn: '16 July 2026',
    });
    expect(out.subject).toBe('Settled: your session with Jordan Ellis');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain('A$12.00');
    expect(html).toContain('Jordan Ellis');
    expect(html.toLowerCase()).not.toContain('overdraft');
  });

  it('renders the within-balance note (no charge) when there was no extra time', async () => {
    const out = getEmailTemplate('session-settled', {
      recipientName: 'Priya',
      expertName: 'Jordan Ellis',
      overdraftSettledMinor: 0,
      settledOn: '16 July 2026',
    });
    expect(out.subject).toBe('Your session with Jordan Ellis wrapped up');
    const html = clean(await render(out.component));
    expect(html).toContain('stayed within your balance');
  });
});

describe('getEmailTemplate — session-settlement-failed', () => {
  it('renders the SCA confirmation copy for requires_action', async () => {
    const out = getEmailTemplate('session-settlement-failed', {
      recipientName: 'Priya',
      amountMinor: 1500,
      reason: 'requires_action',
    });
    expect(out.subject).toBe('Confirm your card to settle your recent session');
    const html = clean(await render(out.component));
    expect(html).toContain('A$15.00');
    expect(html).toContain('confirmation');
    expect(html.toLowerCase()).not.toContain('overdraft');
    // BAL-552 — the SCA arm now also offers the working alternative (a covering top-up).
    expect(html).toContain('or top up to cover it. Either way, the extra time is taken care of');
    expect(html).not.toContain('settles it just the same');
    expect(html).not.toContain('nothing else is on hold'); // retired phrase
    expect(html).toContain('/settings/billing'); // the SCA arm's ctaUrl
  });

  it('renders the decline copy for a declined settlement', async () => {
    const out = getEmailTemplate('session-settlement-failed', {
      recipientName: 'Priya',
      amountMinor: 1500,
      reason: 'declined',
    });
    expect(out.subject).toBe('A payment on your recent session needs attention');
    const html = clean(await render(out.component));
    expect(html).toContain("couldn't settle");
    // BAL-552 — the dunning sweep never re-charges, so the only true remedy is a covering
    // top-up; the card-update remedy + its CTA are retired.
    expect(html).toContain('a top-up that covers it clears it'); // previewText
    expect(html).toContain('A top-up that covers A$15.00 clears it right away'); // bodyLines[1]
    expect(html).toContain('this is just the balance'); // arm-dependent hero subtext
    expect(html).toContain('/billing/top-up'); // the ctaUrl change
    expect(html).toContain('Top up'); // ctaLabel
    expect(html).not.toContain('card details sorts it out'); // retired
    expect(html).not.toContain('card update sorts it'); // retired
    expect(html).not.toContain('/settings/billing'); // the declined arm must no longer link there
    expect(html.toLowerCase()).not.toContain('overdraft');
  });
});

// ── In-app factories (BAL-378) ───────────────────────────────────────────────
describe('getInAppTemplate — session notices', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['session-low-balance', { minutesRemaining: 8 }, 'Balance running low'],
    ['session-grace-entered', {}, "We're keeping you going"],
    ['session-grace-entered-admin', {}, 'A session is running on grace'],
    ['session-near-wrap', { graceRemainingMinutes: 10 }, 'Coming up on a good place to wrap'],
    ['session-topup-nudge', { requestedByName: 'Dana' }, 'Dana asked for a top-up'],
  ];

  for (const [template, data, expectedTitle] of cases) {
    it(`${template} renders its title + a warm body`, () => {
      const out = getInAppTemplate(template, data);
      expect(out.title).toBe(expectedTitle);
      expect(out.body.length).toBeGreaterThan(0);
      expect(`${out.title} ${out.body}`.toLowerCase()).not.toContain('overdraft');
    });
  }

  it('session-settled shows the amount when there was extra time', () => {
    const out = getInAppTemplate('session-settled', {
      overdraftSettledMinor: 1200,
      expertName: 'Jordan',
    });
    expect(out.title).toBe('Extra time settled');
    expect(out.body).toContain('A$12.00');
  });

  it('session-settled has a within-balance note when there was none', () => {
    const out = getInAppTemplate('session-settled', {
      overdraftSettledMinor: 0,
      expertName: 'Jordan',
    });
    expect(out.title).toBe('Session wrapped up');
  });

  it('session-settlement-failed switches on the reason', () => {
    const sca = getInAppTemplate('session-settlement-failed', {
      amountMinor: 1500,
      reason: 'requires_action',
    });
    expect(sca.title).toBe('Confirm your card to finish up');
    const declined = getInAppTemplate('session-settlement-failed', {
      amountMinor: 1500,
      reason: 'declined',
    });
    expect(declined.title).toBe("Let's sort the extra time");
    // BAL-552 — the declined arm's remedy + CTA moved to the top-up composer; the SCA arm's
    // actionUrl is pinned unchanged.
    expect(declined.body).toContain('a top-up that covers it clears it right away');
    expect(declined.body).not.toContain('card update sorts it');
    expect(declined.actionUrl).toBe('/billing/top-up');
    expect(sca.actionUrl).toBe('/settings/billing');
  });
});

// ── SMS templates (BAL-378) ──────────────────────────────────────────────────
describe('getSmsTemplate — session SMS', () => {
  for (const template of ['session-grace-entered-sms', 'session-near-wrap-sms']) {
    it(`${template} is ≤160 chars and free of "overdraft"`, () => {
      const sms = getSmsTemplate(template, {});
      expect(sms.length).toBeLessThanOrEqual(160);
      expect(sms.toLowerCase()).not.toContain('overdraft');
      expect(sms.startsWith('Balo:')).toBe(true);
    });
  }
});
