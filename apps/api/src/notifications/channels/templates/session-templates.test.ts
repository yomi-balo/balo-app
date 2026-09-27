import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
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

/**
 * ⚠ BAL-474 (ADR-1040 Amendment 7 §G, owner ruling D6.2) — the dunning notice is ONE wallet-grain
 * shape. It states the TOTAL top-up that clears the account hold, dated "as of" the instant it was
 * read, and is neutral about how many consultations ran over. Every string below is the
 * owner-approved copy (v2.1 §3 / §4), pinned verbatim — `toBe` / full-sentence `toContain`, never
 * a fragment.
 */
const AS_OF_ISO = '2026-09-23T14:05:00.000Z';
const AS_OF_LABEL = '2:05 pm UTC, 23 September 2026';
const MAX_TOP_UP_MINOR = TOP_UP_LIMITS_MINOR.max;

function dunningData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipientName: 'Priya',
    company: { name: 'Northwind Industrial' },
    topUpNeededMinor: 27_500,
    promoGrantedSinceDebtMinor: 0,
    confirmationWasRequested: false,
    asOfIso: AS_OF_ISO,
    ...over,
  };
}

/** Wording the approved copy retires — none may appear in any dunning string. */
const RETIRED_DUNNING_WORDING =
  /overdraft|extra time|nothing else to do|straight away|right away|taken care of|on file|\bhe\b|\bshe\b|\bhis\b|\bhers?\b/i;

describe('getEmailTemplate — session-settlement-failed (wallet-grain dunning)', () => {
  it('renders the approved copy verbatim: subject, preheader, heading, sub-heading, body, CTA', async () => {
    const out = getEmailTemplate('session-settlement-failed', dunningData());
    expect(out.subject).toBe("Northwind Industrial's balance needs a top-up");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Priya,');
    expect(html).toContain(`As of ${AS_OF_LABEL}, a top-up of A$275.00 or more clears it.`); // preheader
    expect(html).toContain('💳 A quick heads-up');
    expect(html).toContain("Let's settle the balance");
    expect(html).toContain("Consultations already booked aren't affected.");
    expect(html).toContain(
      `As of ${AS_OF_LABEL}, Northwind Industrial's balance needs a top-up of A$275.00 or more to clear. Until it's clear, new consultations can't be booked.`
    );
    expect(html).toContain('Top up');
    expect(html).toContain('/billing/top-up');
    expect(html).toContain('Questions about this?');
    expect(html).not.toMatch(RETIRED_DUNNING_WORDING);
  });

  it('names no session and quotes the wallet figure — a per-receivable amountMinor is never rendered', async () => {
    const out = getEmailTemplate(
      'session-settlement-failed',
      dunningData({ amountMinor: 1_500, reason: 'requires_action' })
    );
    const html = clean(await render(out.component));
    expect(html).toContain('A$275.00');
    expect(html).not.toContain('A$15.00');
    expect(html).not.toMatch(/recent session|confirm your card|couldn't settle/i);
    // The SCA reason no longer changes the CTA: a top-up is the only thing that clears the hold.
    expect(html).not.toContain('/settings/billing');
  });

  it('the as-of label follows the payload instant (a morning instant reads "am")', async () => {
    const out = getEmailTemplate(
      'session-settlement-failed',
      dunningData({ asOfIso: '2026-01-05T09:30:00.000Z' })
    );
    const html = clean(await render(out.component));
    expect(html).toContain(
      'As of 9:30 am UTC, 5 January 2026, a top-up of A$275.00 or more clears it.'
    );
  });

  describe('confirmationWasRequested', () => {
    const CONFIRMATION_SENTENCE =
      "One earlier payment needed an extra card confirmation when it was attempted — it's worth a quick look at the card in billing settings.";

    it('false → no confirmation sentence and no card link', async () => {
      const out = getEmailTemplate('session-settlement-failed', dunningData());
      const html = clean(await render(out.component));
      expect(html).not.toContain('extra card confirmation');
      expect(html).not.toContain('Check the card in billing settings');
      expect(html).not.toContain('/settings/billing');
    });

    it('true → one retrospective sentence and a secondary card-settings link; the CTA stays "Top up"', async () => {
      const out = getEmailTemplate(
        'session-settlement-failed',
        dunningData({ confirmationWasRequested: true })
      );
      const html = clean(await render(out.component));
      expect(html).toContain(CONFIRMATION_SENTENCE);
      expect(html).toContain('Check the card in billing settings');
      expect(html).toContain('/settings/billing'); // the secondary link only
      expect(html).toContain('Top up →');
      expect(html).toContain('/billing/top-up');
      // A card swap after the attempt cannot make it false: it states a past fact about an attempt
      // and makes no present-tense claim about the card.
      expect(CONFIRMATION_SENTENCE).not.toMatch(/needs|your card|on file/i);
    });
  });

  describe('promoWasGranted', () => {
    const PROMO_SENTENCE =
      "Anything beyond what's owed stays in your balance to use on consultations. Promo credit doesn't count towards clearing it, which is why this figure can be higher than what's owed.";

    it('a positive promo grant adds the promo sentence', async () => {
      const out = getEmailTemplate(
        'session-settlement-failed',
        dunningData({ promoGrantedSinceDebtMinor: 2_000 })
      );
      expect(clean(await render(out.component))).toContain(PROMO_SENTENCE);
    });

    it('a zero promo grant adds nothing', async () => {
      const out = getEmailTemplate(
        'session-settlement-failed',
        dunningData({ promoGrantedSinceDebtMinor: 0 })
      );
      expect(clean(await render(out.component))).not.toContain('Promo credit');
    });
  });

  describe('the per-top-up maximum', () => {
    it('at exactly the maximum the singular wording still applies (the top-up page accepts it)', async () => {
      const out = getEmailTemplate(
        'session-settlement-failed',
        dunningData({ topUpNeededMinor: MAX_TOP_UP_MINOR })
      );
      const html = clean(await render(out.component));
      expect(html).toContain(`As of ${AS_OF_LABEL}, a top-up of A$10,000.00 or more clears it.`);
      expect(html).toContain(
        "Northwind Industrial's balance needs a top-up of A$10,000.00 or more to clear."
      );
      expect(html).not.toContain('totalling');
      expect(html).not.toContain('each top-up can be up to');
    });

    it('one minor unit above the maximum switches to "top-ups totalling" in the preheader AND the body', async () => {
      const out = getEmailTemplate(
        'session-settlement-failed',
        dunningData({ topUpNeededMinor: MAX_TOP_UP_MINOR + 1 })
      );
      const html = clean(await render(out.component));
      expect(html).toContain(
        `As of ${AS_OF_LABEL}, top-ups totalling A$10,000.01 or more clear it.`
      );
      expect(html).toContain(
        `As of ${AS_OF_LABEL}, Northwind Industrial's balance needs top-ups totalling A$10,000.01 or more to clear — each top-up can be up to A$10,000. Until it's clear, new consultations can't be booked.`
      );
      expect(html).not.toContain('a top-up of');
    });
  });

  it('falls back to "Your team" / "your team" when the company name did not resolve', async () => {
    const out = getEmailTemplate('session-settlement-failed', dunningData({ company: null }));
    expect(out.subject).toBe("Your team's balance needs a top-up");
    const html = clean(await render(out.component));
    expect(html).toContain("your team's balance needs a top-up of A$275.00 or more to clear");
  });

  it('greets "there" for a name-less recipient', async () => {
    const out = getEmailTemplate(
      'session-settlement-failed',
      dunningData({ recipientName: undefined })
    );
    expect(clean(await render(out.component))).toContain('Hi there,');
  });

  it('never renders A$0.00: a missing, zero or undated figure is a contract break that throws', () => {
    expect(() =>
      getEmailTemplate('session-settlement-failed', dunningData({ topUpNeededMinor: 0 }))
    ).toThrow(/topUpNeededMinor/);
    expect(() =>
      getEmailTemplate('session-settlement-failed', dunningData({ topUpNeededMinor: undefined }))
    ).toThrow(/topUpNeededMinor/);
    expect(() =>
      getEmailTemplate('session-settlement-failed', dunningData({ asOfIso: undefined }))
    ).toThrow(/asOfIso/);
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

  /**
   * ⚠ BAL-405 — VERBATIM body pins. These two moments fire alongside the in-session panel, and
   * before this ticket they promised an interruption / a pause that never happens on the
   * presence path (ADR-1052 D2). Nothing pinned either body, so the wording could drift back
   * silently. `toBe`, never `toContain`.
   */
  it('⚠ session-low-balance stays ahead of the balance instead of promising no interruption', () => {
    const out = getInAppTemplate('session-low-balance', { minutesRemaining: 8 });
    expect(out.body).toBe('About 8 minutes of balance left — top up any time to stay ahead of it.');
    expect(out.body).not.toContain('interrupt');
  });

  it('⚠ session-near-wrap names the extra time instead of promising a pause', () => {
    const out = getInAppTemplate('session-near-wrap', { graceRemainingMinutes: 10 });
    expect(out.body).toBe('About 10 more minutes of the extra time we set aside.');
    expect(out.body).not.toContain('pause');
  });

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

  it('session-settlement-failed states the total top-up, dated, and links to the top-up page', () => {
    const out = getInAppTemplate('session-settlement-failed', dunningData());
    expect(out.title).toBe("Northwind Industrial's balance needs a top-up");
    expect(out.body).toBe(
      `As of ${AS_OF_LABEL}, a top-up of A$275.00 or more clears it. Until it's clear, new consultations can't be booked.`
    );
    expect(out.actionUrl).toBe('/billing/top-up');
    expect(`${out.title} ${out.body}`).not.toMatch(RETIRED_DUNNING_WORDING);
  });

  it('session-settlement-failed ignores a per-receivable amountMinor and the retired reason switch', () => {
    const out = getInAppTemplate(
      'session-settlement-failed',
      dunningData({ amountMinor: 1_500, reason: 'requires_action' })
    );
    expect(out.body).toContain('A$275.00');
    expect(out.body).not.toContain('A$15.00');
    expect(out.title).not.toContain('Confirm your card');
    expect(out.actionUrl).toBe('/billing/top-up');
  });

  it('session-settlement-failed suffixes: promo, confirmation, both (in that order), neither', () => {
    const base = `As of ${AS_OF_LABEL}, a top-up of A$275.00 or more clears it. Until it's clear, new consultations can't be booked.`;
    const promo = "Promo credit doesn't count towards clearing it.";
    const confirmation =
      'One earlier payment needed an extra card confirmation — worth a check in billing settings.';
    const body = (over: Record<string, unknown>): string =>
      getInAppTemplate('session-settlement-failed', dunningData(over)).body;
    expect(body({})).toBe(base);
    expect(body({ promoGrantedSinceDebtMinor: 1 })).toBe(`${base} ${promo}`);
    expect(body({ confirmationWasRequested: true })).toBe(`${base} ${confirmation}`);
    expect(body({ promoGrantedSinceDebtMinor: 1, confirmationWasRequested: true })).toBe(
      `${base} ${promo} ${confirmation}`
    );
  });

  it('session-settlement-failed: both limit edges — the maximum is singular, one unit above is "top-ups totalling"', () => {
    const atMax = getInAppTemplate(
      'session-settlement-failed',
      dunningData({ topUpNeededMinor: MAX_TOP_UP_MINOR })
    );
    expect(atMax.body).toBe(
      `As of ${AS_OF_LABEL}, a top-up of A$10,000.00 or more clears it. Until it's clear, new consultations can't be booked.`
    );
    const aboveMax = getInAppTemplate(
      'session-settlement-failed',
      dunningData({ topUpNeededMinor: MAX_TOP_UP_MINOR + 1 })
    );
    expect(aboveMax.body).toBe(
      `As of ${AS_OF_LABEL}, top-ups totalling A$10,000.01 or more clear it (each up to A$10,000). Until it's clear, new consultations can't be booked.`
    );
  });

  it('session-settlement-failed falls back to "Your team" and never renders A$0.00', () => {
    expect(
      getInAppTemplate('session-settlement-failed', dunningData({ company: null })).title
    ).toBe("Your team's balance needs a top-up");
    expect(() =>
      getInAppTemplate('session-settlement-failed', dunningData({ topUpNeededMinor: 0 }))
    ).toThrow(/topUpNeededMinor/);
    expect(() =>
      getInAppTemplate('session-settlement-failed', dunningData({ asOfIso: undefined }))
    ).toThrow(/asOfIso/);
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

  // ⚠ BAL-405 — a VERBATIM pin, not just the ≤160 sweep above: this SMS fires at the same moment
  // as the `near` panel copy, and previously promised a "break" the presence path never takes.
  it('⚠ session-near-wrap-sms promises no break — verbatim', () => {
    expect(getSmsTemplate('session-near-wrap-sms', {})).toBe(
      'Balo: Your session is nearing the end of its extra time — top up any time to stay ahead of it.'
    );
  });
});
