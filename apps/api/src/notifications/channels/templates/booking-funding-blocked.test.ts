import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { BookingFundingBlockedEmail } from './booking-funding-blocked.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';
import type { FundingBlockNotice } from './top-up-figure.js';

const BASE = 'https://app.balo.expert';
const AS_OF_ISO = '2026-09-23T14:05:00.000Z';
const AS_OF_LABEL = '2:05 pm UTC, 23 September 2026';
const MAX = TOP_UP_LIMITS_MINOR.max;
const REQUESTER = 'Dana @ Northwind Industrial';

/** Same normalisation as `credit-topup.test.ts` — strips React-Email's interpolation markers. */
function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

/** An anchor whose href ends in `path` — the factory builds its own base URL from the environment. */
function hrefTo(path: string): RegExp {
  return new RegExp(`href="[^"]*${path}"`);
}

/** Wording the approved copy never uses, on any arm, in any channel. */
const FORBIDDEN_ANYWHERE =
  /waiting|is held|has been held|from your team|still open|straight through|straight away|right away|without this happening again|nothing else to do|urgent|immediately|deadline|hurry|act now|right now|overdraft|\b(he|she|him|her|his|hers)\b/i;

const UNFUNDED: FundingBlockNotice = { variant: 'unfunded' };
const HOLD_FALLBACK: FundingBlockNotice = { variant: 'hold_fallback' };
const figure = (amount: string, exceedsSingleTopUp = false) => ({
  amount,
  asOf: AS_OF_LABEL,
  exceedsSingleTopUp,
  maxTopUp: 'A$10,000',
});

describe('BookingFundingBlockedEmail — unfunded arm (BAL-478, strings unchanged)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Sam',
    requestedByLabel: REQUESTER,
    expertPartyLabel: 'CloudPeak',
    companyLabel: 'Northwind Industrial',
    notice: UNFUNDED,
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  });

  /**
   * B2 (fix round 2) — the component takes `requestedByLabel` PRE-COMPOSED (by the resolver)
   * and renders it verbatim; it does no `personWithOrgLabel` computation of its own.
   *
   * Fix round 3 — every line is LITERALLY TRUE AT READ TIME, not just at send time: "nothing
   * was booked, so no time was held" is a past fact, never a present-tense claim about the
   * slot's live availability (which could be false by the time a billing admin reads it). The
   * pill never claims to be "from your team". And no line PROMISES an outcome ("goes straight
   * through" / "book right away") — the gate can refuse a second attempt too, so copy describes
   * the action available ("try booking again"), never a guaranteed result.
   */
  it('renders the setup-step copy — labelled first mention, no false claims, no promised outcome', async () => {
    const html = clean(await render(BookingFundingBlockedEmail(props())));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain('🔔 A quick setup step');
    expect(html).toContain("A booking couldn't go through");
    expect(html).toContain('One quick setup and your team can try booking again.');
    expect(html).toContain(
      "Dana @ Northwind Industrial tried to book a consultation with CloudPeak, but it couldn't go through — your team needs a payment method on file, or enough credit to cover it. Nothing was booked, so no time was held. Add either one and your team can try booking again."
    );
    expect(html).toContain('Set up billing');
    expect(html).toContain(`${BASE}/settings/billing`);
    expect(html).not.toMatch(FORBIDDEN_ANYWHERE);
  });

  it('carries no money figure and no dunning/urgency language', async () => {
    const html = clean(await render(BookingFundingBlockedEmail(props())));
    // ⚠ `\$\d` (a dollar sign immediately followed by a digit), NOT a bare `\$` — React Email
    // itself emits `<!--$-->` / `<!--/$-->` Suspense boundary markers in the raw HTML, which a
    // bare `\$` check flags as a false positive with no money involved.
    expect(html).not.toMatch(/\$\d|balance|shortfall|amount|overdue|as of/i);
    expect(html).not.toMatch(/top-?up/i);
  });
});

describe('BookingFundingBlockedEmail — balance arms', () => {
  const props = (notice: FundingBlockNotice, over: Record<string, unknown> = {}) => ({
    firstName: 'Sam',
    requestedByLabel: REQUESTER,
    expertPartyLabel: 'CloudPeak',
    companyLabel: 'Northwind Industrial',
    notice,
    ctaUrl: `${BASE}/billing/top-up`,
    baseUrl: BASE,
    ...over,
  });

  it('hold + figure: the dated top-up, "or more", no promised booking', async () => {
    const html = clean(
      await render(
        BookingFundingBlockedEmail(props({ variant: 'hold', figure: figure('A$275.00') }))
      )
    );
    expect(html).toContain('🔔 A quick heads-up');
    expect(html).toContain("Consultations already booked aren't affected.");
    expect(html).toContain(
      `As of ${AS_OF_LABEL}, a top-up of A$275.00 or more clears Northwind Industrial's balance.`
    );
    expect(html).toContain(
      `Dana @ Northwind Industrial tried to book a consultation with CloudPeak, but it couldn't go through. As of ${AS_OF_LABEL}, Northwind Industrial's balance needs a top-up of A$275.00 or more before new consultations can be booked. Nothing was booked, so no time was held. Once it's topped up, your team can try booking again.`
    );
    expect(html).toContain('Top up');
    expect(html).toContain(`${BASE}/billing/top-up`);
    expect(html).not.toMatch(FORBIDDEN_ANYWHERE);
  });

  it('hold + a figure above the per-top-up maximum uses "top-ups totalling" in the preheader AND the body', async () => {
    const html = clean(
      await render(
        BookingFundingBlockedEmail(props({ variant: 'hold', figure: figure('A$10,000.01', true) }))
      )
    );
    expect(html).toContain(
      `As of ${AS_OF_LABEL}, top-ups totalling A$10,000.01 or more clear Northwind Industrial's balance.`
    );
    expect(html).toContain(
      `As of ${AS_OF_LABEL}, Northwind Industrial's balance needs top-ups totalling A$10,000.01 or more (each top-up can be up to A$10,000) before new consultations can be booked.`
    );
    expect(html).not.toContain('a top-up of');
  });

  it('hold failed-heal fallback: no figure, no as-of, never A$0.00', async () => {
    const html = clean(await render(BookingFundingBlockedEmail(props(HOLD_FALLBACK))));
    expect(html).toContain(
      'The balance already covered it — it lifts automatically within a day, or at once with any top-up.'
    );
    expect(html).toContain(
      "Dana @ Northwind Industrial tried to book a consultation with CloudPeak, but it couldn't go through: an earlier hold was still on Northwind Industrial's account, although the balance already covered it. Nothing was booked, so no time was held. The hold lifts automatically within a day, or at once with any top-up, and then your team can try booking again."
    );
    expect(html).toContain("Consultations already booked aren't affected.");
    expect(html).toContain('Top up');
    expect(html).not.toMatch(/A\$|as of/i);
    expect(html).not.toMatch(FORBIDDEN_ANYWHERE);
  });

  it('reserved: the dated top-up that would make room, and only the COUNT of planned consultations', async () => {
    const html = clean(
      await render(
        BookingFundingBlockedEmail(
          props({ variant: 'reserved', figure: figure('A$120.00'), count: 2 })
        )
      )
    );
    expect(html).toContain("Planned consultations aren't affected.");
    expect(html).toContain(
      `As of ${AS_OF_LABEL}, a top-up of A$120.00 or more would make room for it alongside the 2 upcoming consultations already planned.`
    );
    expect(html).toContain(
      `Dana @ Northwind Industrial tried to book a consultation with CloudPeak, but it couldn't go through: as of ${AS_OF_LABEL}, part of Northwind Industrial's balance was set aside for 2 upcoming consultations, so there wasn't enough left for this one. A top-up of A$120.00 or more would make room for it. Nothing was booked, so no time was held, and nothing had been taken from Northwind Industrial's balance for the planned consultations.`
    );
    expect(html).toContain('Top up');
    expect(html).not.toMatch(FORBIDDEN_ANYWHERE);
  });

  it('reserved with a single planned consultation reads "1 upcoming consultation"', async () => {
    const html = clean(
      await render(
        BookingFundingBlockedEmail(
          props({ variant: 'reserved', figure: figure('A$120.00'), count: 1 })
        )
      )
    );
    expect(html).toContain('set aside for 1 upcoming consultation, so there');
    expect(html).toContain('alongside the 1 upcoming consultation already planned.');
  });

  it('reserved above the per-top-up maximum uses "top-ups totalling" and names the maximum', async () => {
    const html = clean(
      await render(
        BookingFundingBlockedEmail(
          props({ variant: 'reserved', figure: figure('A$10,000.01', true), count: 3 })
        )
      )
    );
    // React Email truncates a preheader at 150 characters, and this approved string is 155 — so the
    // pin is on the prefix the inbox can show.
    expect(html).toContain(
      `As of ${AS_OF_LABEL}, top-ups totalling A$10,000.01 or more would make room for it alongside the 3`
    );
    expect(html).toContain(
      'Top-ups totalling A$10,000.01 or more (each up to A$10,000) would make room for it.'
    );
  });
});

describe('getEmailTemplate — booking-funding-blocked factory', () => {
  const data = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    recipientName: 'Sam',
    requestedByLabel: REQUESTER,
    expertPartyLabel: 'CloudPeak',
    company: { name: 'Northwind Industrial' },
    ...over,
  });
  const holdData = (over: Record<string, unknown> = {}) =>
    data({ blockKind: 'account_on_hold', topUpNeededMinor: 27_500, asOfIso: AS_OF_ISO, ...over });
  const reservedData = (over: Record<string, unknown> = {}) =>
    data({
      blockKind: 'reserved_by_upcoming',
      topUpNeededMinor: 12_000,
      reservedBookingCount: 2,
      asOfIso: AS_OF_ISO,
      ...over,
    });

  it('unfunded: subject and body reuse the resolver-composed requestedByLabel verbatim, and carry no money figure', async () => {
    const out = getEmailTemplate('booking-funding-blocked', data({ blockKind: 'unfunded' }));
    expect(out.subject).toBe('Dana @ Northwind Industrial needs billing set up to book');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain('CloudPeak');
    expect(html).toMatch(hrefTo('/settings/billing'));
    expect(html).not.toMatch(/\$\d|as of/i);
  });

  it('a payload with no blockKind reads as the unfunded arm (no figure, billing settings)', async () => {
    const out = getEmailTemplate('booking-funding-blocked', data());
    expect(out.subject).toBe('Dana @ Northwind Industrial needs billing set up to book');
    expect(clean(await render(out.component))).toMatch(hrefTo('/settings/billing'));
  });

  it('hold + figure: subject, figure, as-of label and the top-up CTA', async () => {
    const out = getEmailTemplate('booking-funding-blocked', holdData());
    expect(out.subject).toBe(
      "Dana @ Northwind Industrial couldn't book — Northwind Industrial's balance needs a top-up"
    );
    const html = clean(await render(out.component));
    expect(html).toContain('A$275.00');
    expect(html).toContain(AS_OF_LABEL);
    expect(html).toMatch(hrefTo('/billing/top-up'));
    expect(html).not.toMatch(hrefTo('/settings/billing'));
  });

  it('hold: both limit edges — the maximum is singular, one unit above is "top-ups totalling"', async () => {
    const atMax = getEmailTemplate('booking-funding-blocked', holdData({ topUpNeededMinor: MAX }));
    const atMaxHtml = clean(await render(atMax.component));
    expect(atMaxHtml).toContain('needs a top-up of A$10,000.00 or more before');
    expect(atMaxHtml).not.toContain('totalling');
    const above = getEmailTemplate(
      'booking-funding-blocked',
      holdData({ topUpNeededMinor: MAX + 1 })
    );
    const aboveHtml = clean(await render(above.component));
    expect(aboveHtml).toContain(
      'needs top-ups totalling A$10,000.01 or more (each top-up can be up to A$10,000) before'
    );
    expect(aboveHtml).toContain(
      `As of ${AS_OF_LABEL}, top-ups totalling A$10,000.01 or more clear Northwind Industrial's balance.`
    );
  });

  it('hold with no figure — or a zero — is the failed-heal fallback and never renders A$0.00', async () => {
    for (const over of [
      { topUpNeededMinor: undefined, asOfIso: undefined },
      { topUpNeededMinor: 0 },
      { topUpNeededMinor: 0, asOfIso: undefined },
    ]) {
      const out = getEmailTemplate('booking-funding-blocked', holdData(over));
      expect(out.subject).toBe(
        "Dana @ Northwind Industrial couldn't book — an earlier hold on Northwind Industrial's account was still clearing"
      );
      const html = clean(await render(out.component));
      expect(html).toContain('an earlier hold was still on Northwind Industrial');
      expect(html).toMatch(hrefTo('/billing/top-up'));
      expect(html).not.toMatch(/A\$|as of|NaN|undefined/i);
    }
  });

  it('a hold with a positive figure but no usable instant degrades to the unfunded arm — never "the balance already covered it"', async () => {
    for (const over of [{ asOfIso: undefined }, { asOfIso: '' }]) {
      const out = getEmailTemplate('booking-funding-blocked', holdData(over));
      expect(out.subject).toBe('Dana @ Northwind Industrial needs billing set up to book');
      const html = clean(await render(out.component));
      expect(html).toMatch(hrefTo('/settings/billing'));
      expect(html).not.toMatch(/A\$|as of|earlier hold|already covered/i);
    }
  });

  it('reserved: subject, figure, as-of, count and the top-up CTA', async () => {
    const out = getEmailTemplate('booking-funding-blocked', reservedData());
    expect(out.subject).toBe(
      "Dana @ Northwind Industrial couldn't book — part of Northwind Industrial's balance was set aside for planned consultations"
    );
    const html = clean(await render(out.component));
    expect(html).toContain('A$120.00');
    expect(html).toContain('2 upcoming consultations');
    expect(html).toContain(AS_OF_LABEL);
    expect(html).toMatch(hrefTo('/billing/top-up'));
  });

  it('a malformed reserved payload (no figure or no count) degrades to the unfunded arm — never A$0.00', async () => {
    for (const over of [
      { topUpNeededMinor: undefined, asOfIso: undefined },
      { reservedBookingCount: undefined },
    ]) {
      const out = getEmailTemplate('booking-funding-blocked', reservedData(over));
      expect(out.subject).toBe('Dana @ Northwind Industrial needs billing set up to book');
      expect(clean(await render(out.component))).not.toMatch(/A\$|as of/i);
    }
  });

  it('falls back to "your team" when the company name did not resolve', async () => {
    const out = getEmailTemplate('booking-funding-blocked', holdData({ company: null }));
    expect(out.subject).toBe(
      "Dana @ Northwind Industrial couldn't book — your team's balance needs a top-up"
    );
    expect(clean(await render(out.component))).toContain("your team's balance needs a top-up of");
  });

  it('degrades to placeholders on empty data, without throwing', async () => {
    const out = getEmailTemplate('booking-funding-blocked', {});
    expect(out.subject).toBe('A teammate needs billing set up to book');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
    expect(html).toContain('an expert');
  });
});

describe('getInAppTemplate — booking-funding-blocked factory', () => {
  const data = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    requestedByLabel: REQUESTER,
    expertPartyLabel: 'CloudPeak',
    company: { name: 'Northwind Industrial' },
    ...over,
  });
  const holdData = (over: Record<string, unknown> = {}) =>
    data({ blockKind: 'account_on_hold', topUpNeededMinor: 27_500, asOfIso: AS_OF_ISO, ...over });
  const reservedData = (over: Record<string, unknown> = {}) =>
    data({
      blockKind: 'reserved_by_upcoming',
      topUpNeededMinor: 12_000,
      reservedBookingCount: 2,
      asOfIso: AS_OF_ISO,
      ...over,
    });

  it('unfunded: reuses requestedByLabel verbatim, carries no money figure, links to billing settings', () => {
    const out = getInAppTemplate('booking-funding-blocked', data({ blockKind: 'unfunded' }));
    expect(out.title).toBe("A booking couldn't go through");
    expect(out.body).toBe(
      "Dana @ Northwind Industrial tried to book a consultation with CloudPeak, but it couldn't go through. Nothing was booked, so no time was held. Add a payment method or top up, then try booking again."
    );
    expect(out.actionUrl).toBe('/settings/billing');
    expect(out.body).not.toMatch(/\$|as of/i);
    expect(out.body).not.toMatch(FORBIDDEN_ANYWHERE);
  });

  it('hold + figure: the dated top-up, links to the top-up page', () => {
    const out = getInAppTemplate('booking-funding-blocked', holdData());
    expect(out.title).toBe("A booking couldn't go through");
    expect(out.body).toBe(
      `Dana @ Northwind Industrial tried to book with CloudPeak. As of ${AS_OF_LABEL}, Northwind Industrial's balance needs a top-up of A$275.00 or more before new consultations can be booked. Nothing was booked.`
    );
    expect(out.actionUrl).toBe('/billing/top-up');
    expect(out.body).not.toMatch(FORBIDDEN_ANYWHERE);
  });

  it('hold: both limit edges — the maximum is singular, one unit above is "top-ups totalling"', () => {
    expect(
      getInAppTemplate('booking-funding-blocked', holdData({ topUpNeededMinor: MAX })).body
    ).toContain('balance needs a top-up of A$10,000.00 or more before new consultations');
    const above = getInAppTemplate(
      'booking-funding-blocked',
      holdData({ topUpNeededMinor: MAX + 1 })
    );
    expect(above.body).toBe(
      `Dana @ Northwind Industrial tried to book with CloudPeak. As of ${AS_OF_LABEL}, Northwind Industrial's balance needs top-ups totalling A$10,000.01 or more before new consultations can be booked. Nothing was booked.`
    );
  });

  it('hold failed-heal fallback: no figure, no as-of, never A$0.00', () => {
    for (const over of [
      { topUpNeededMinor: undefined, asOfIso: undefined },
      { topUpNeededMinor: 0 },
    ]) {
      const out = getInAppTemplate('booking-funding-blocked', holdData(over));
      expect(out.body).toBe(
        "Dana @ Northwind Industrial tried to book with CloudPeak while an earlier hold was still on Northwind Industrial's account, although the balance already covered it. It lifts automatically within a day, or at once with any top-up. Nothing was booked."
      );
      expect(out.body).not.toMatch(/A\$|as of/i);
      expect(out.actionUrl).toBe('/billing/top-up');
    }
  });

  it('a hold with a positive figure but no usable instant degrades to the unfunded arm — never "the balance already covered it"', () => {
    for (const over of [{ asOfIso: undefined }, { asOfIso: '' }]) {
      const out = getInAppTemplate('booking-funding-blocked', holdData(over));
      expect(out.actionUrl).toBe('/settings/billing');
      expect(out.body).not.toMatch(/A\$|as of|earlier hold|already covered/i);
    }
  });

  it('reserved: the dated top-up that would make room, the count, and the top-up link — plus the "top-ups totalling" edge', () => {
    const out = getInAppTemplate('booking-funding-blocked', reservedData());
    expect(out.body).toBe(
      `Dana @ Northwind Industrial tried to book with CloudPeak. As of ${AS_OF_LABEL}, part of Northwind Industrial's balance was set aside for 2 upcoming consultations — a top-up of A$120.00 or more would make room for it. Nothing was booked.`
    );
    expect(out.actionUrl).toBe('/billing/top-up');
    const atMax = getInAppTemplate(
      'booking-funding-blocked',
      reservedData({ topUpNeededMinor: MAX })
    );
    expect(atMax.body).toContain('— a top-up of A$10,000.00 or more would make room for it.');
    const above = getInAppTemplate(
      'booking-funding-blocked',
      reservedData({ topUpNeededMinor: MAX + 1, reservedBookingCount: 1 })
    );
    expect(above.body).toBe(
      `Dana @ Northwind Industrial tried to book with CloudPeak. As of ${AS_OF_LABEL}, part of Northwind Industrial's balance was set aside for 1 upcoming consultation — top-ups totalling A$10,000.01 or more would make room for it. Nothing was booked.`
    );
  });

  it('a malformed reserved payload degrades to the unfunded arm — never A$0.00', () => {
    const out = getInAppTemplate(
      'booking-funding-blocked',
      reservedData({ topUpNeededMinor: undefined, asOfIso: undefined })
    );
    expect(out.actionUrl).toBe('/settings/billing');
    expect(out.body).not.toMatch(/A\$|as of/i);
  });

  it('falls back to "your team" when the company name did not resolve', () => {
    expect(getInAppTemplate('booking-funding-blocked', holdData({ company: null })).body).toContain(
      "As of 2:05 pm UTC, 23 September 2026, your team's balance needs a top-up of A$275.00 or more"
    );
  });

  it('degrades to placeholders on empty data, without throwing', () => {
    const out = getInAppTemplate('booking-funding-blocked', {});
    expect(out.title).toBe("A booking couldn't go through");
    expect(out.body).toContain('A teammate tried to book a consultation with an expert');
  });
});
