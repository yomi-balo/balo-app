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
