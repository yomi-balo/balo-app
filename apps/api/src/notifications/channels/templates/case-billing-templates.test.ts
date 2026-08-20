import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

// Fee-concealment at the TEMPLATE layer (BAL-399): a payment receipt names the client all-in +
// the expert (display), NEVER an expert earnings figure or margin; a payout notice names the
// expert's own earnings, NEVER the client charge, markup, or margin.

// The expert accrual for the same session (A$112.50) — deliberately NOT passed to the client
// template, asserted absent so the "own-side figure only" guarantee is exercised, not vacuous.
const EXPERT_EARNINGS_SENTINEL = 'A$112.50';
const CLIENT_CHARGE_SENTINEL = 'A$150.00';

describe('getEmailTemplate — payment-charged (member receipt)', () => {
  it('renders the client all-in charge + expert name, with no expert figure / margin', async () => {
    const out = getEmailTemplate('payment-charged', {
      recipientName: 'Jordan',
      expertName: 'Amara Okafor',
      amountAudMinor: 15_000,
      durationMinutes: 45,
      chargedOn: '20 July 2026',
    });
    expect(out.subject).toBe('Your session with Amara Okafor — receipt');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain(CLIENT_CHARGE_SENTINEL);
    expect(html).toContain('Amara Okafor');
    expect(html).toContain('45');
    // No counterparty (expert-earnings) figure or fee/earnings/payout concept. ("margin" is
    // deliberately NOT asserted on the raw email HTML — it collides with the CSS `margin:` prop.)
    expect(html).not.toContain(EXPERT_EARNINGS_SENTINEL);
    expect(html.toLowerCase()).not.toContain('markup');
    expect(html.toLowerCase()).not.toContain('earnings');
    expect(html.toLowerCase()).not.toContain('payout');
  });
});

describe('getEmailTemplate — payout-recorded (expert earnings)', () => {
  it('renders the expert own earnings, with no client charge / markup / margin', async () => {
    const out = getEmailTemplate('payout-recorded', {
      recipientName: 'Amara',
      amountAudMinor: 11_250,
      durationMinutes: 45,
      recordedOn: '20 July 2026',
    });
    expect(out.subject).toBe('Your session earnings are recorded');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Amara,');
    expect(html).toContain(EXPERT_EARNINGS_SENTINEL);
    expect(html).toContain('45');
    // No counterparty (client-charge) figure or markup/client concept. ("margin" is deliberately
    // NOT asserted on the raw email HTML — it collides with the CSS `margin:` property.)
    expect(html).not.toContain(CLIENT_CHARGE_SENTINEL);
    expect(html.toLowerCase()).not.toContain('markup');
    expect(html.toLowerCase()).not.toContain('client');
  });
});

// BAL-412 (ADR-1044 §7, D8) — the expert never joined. Client register is APOLOGETIC, expert
// register is FACTUAL / never punitive. Neither carries a money figure (nothing was charged).
describe('getEmailTemplate — session-missed-call-client (apologetic, no figure)', () => {
  it('renders an apologetic notice naming the expert and scheduled date — no figure anywhere', async () => {
    const out = getEmailTemplate('session-missed-call-client', {
      recipientName: 'Jordan',
      expertName: 'Amara Okafor',
      scheduledOn: '20 July 2026',
    });
    expect(out.subject).toBe("We're sorry — your session with Amara Okafor didn't connect");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('Amara Okafor');
    expect(html).toContain('20 July 2026');
    expect(html.toLowerCase()).toContain('nothing has been charged');
    // No money figure — this event carries none.
    expect(html).not.toContain('A$');
  });
});

describe('getEmailTemplate — session-missed-call-expert (factual, never punitive)', () => {
  it('renders a factual no-payment notice with no penalty language', async () => {
    const out = getEmailTemplate('session-missed-call-expert', {
      recipientName: 'Amara',
      scheduledOn: '20 July 2026',
    });
    expect(out.subject).toBe('A consultation was recorded as a missed call');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Amara,');
    expect(html).toContain('20 July 2026');
    expect(html.toLowerCase()).toContain('no payment applies');
    // Never punitive — no penalty/fault/blame language.
    expect(html.toLowerCase()).not.toContain('penalty');
    expect(html.toLowerCase()).not.toContain('fault');
    expect(html).not.toContain('A$');
  });
});

describe('getInAppTemplate — case-billing notices', () => {
  it('payment-charged shows the client all-in + expert name, no expert figure', () => {
    const out = getInAppTemplate('payment-charged', {
      amountAudMinor: 15_000,
      expertName: 'Amara Okafor',
    });
    expect(out.title).toBe('Session receipt');
    expect(out.body).toContain(CLIENT_CHARGE_SENTINEL);
    expect(out.body).toContain('Amara Okafor');
    expect(out.body).not.toContain(EXPERT_EARNINGS_SENTINEL);
    expect(`${out.title} ${out.body}`.toLowerCase()).not.toContain('margin');
  });

  it('payout-recorded shows the expert own earnings, no client charge', () => {
    const out = getInAppTemplate('payout-recorded', { amountAudMinor: 11_250 });
    expect(out.title).toBe('Earnings recorded');
    expect(out.body).toContain(EXPERT_EARNINGS_SENTINEL);
    expect(out.body).not.toContain(CLIENT_CHARGE_SENTINEL);
    expect(`${out.title} ${out.body}`.toLowerCase()).not.toContain('client');
  });

  it('session-missed-call-client is apologetic and names the expert (BAL-412)', () => {
    const out = getInAppTemplate('session-missed-call-client', { expertName: 'Amara Okafor' });
    expect(out.title).toBe("We're sorry — your session didn't connect");
    expect(out.body).toContain('Amara Okafor');
    expect(out.body.toLowerCase()).toContain('nothing has been charged');
    expect(out.actionUrl).toBe('/settings/billing');
  });

  it('session-missed-call-expert is factual and never punitive (BAL-412)', () => {
    const out = getInAppTemplate('session-missed-call-expert', {});
    expect(out.title).toBe('A consultation was recorded as a missed call');
    expect(out.body.toLowerCase()).toContain('no payment applies');
    expect(`${out.title} ${out.body}`.toLowerCase()).not.toContain('penalty');
    expect(out.actionUrl).toBe('/settings/earnings');
  });
});

// ── BAL-412 (F16, ADR-1044 §7) — THE `no_show_client` RECEIPTS ────────────────────────────
//
// ⚠ THESE ARE THE ORDINARY RECEIPT EVENTS, CONDITIONED. Unlike `missed_call` (its own bespoke
// event), a client no-show settles through `payment.charged` / `payout.recorded` — so without the
// conditional sentence the client who never joined gets an unremarkable "your 15-minute session
// came to A$X" for a call they were not on. The AC: "No-show settled → client → email + in-app.
// Factual, never punitive" and "→ expert → in-app (accrual confirmation)".
//
// Each side is asserted on THREE axes: the sentence is PRESENT with the settled floor; it is
// FACTUAL (no blame vocabulary); and it is ABSENT on every other shape, so the shipped
// `live_capture` receipt is provably untouched.

/** Words that would make either notice punitive. Asserted absent on both lenses. */
const BLAME_WORDS = ['penalty', 'penalise', 'penalize', 'fault', 'failed to', 'you missed'];

describe('BAL-412 F16 — payment-charged carries the no-show sentence (client lens)', () => {
  it('states the minimum and what the consultant did, factually — never blaming the recipient', async () => {
    const out = getEmailTemplate('payment-charged', {
      recipientName: 'Jordan',
      expertName: 'Amara Okafor',
      amountAudMinor: 15_000,
      durationMinutes: 15,
      chargedOn: '20 July 2026',
      settlementShape: 'no_show_client',
      actualMinutes: 18,
      billingFloorMinutes: 15,
    });
    const html = clean(await render(out.component));
    expect(html).toContain('No one from your side joined this one');
    expect(html).toContain('Amara Okafor');
    // The SNAPSHOTTED floor, and the ACTUAL minutes the expert waited (18, not the billed 15) —
    // the whole reason `actual_minutes` is a column.
    expect(html).toContain('15-minute minimum');
    expect(html).toContain('waited 18 minutes');
    for (const word of BLAME_WORDS) {
      expect(html.toLowerCase()).not.toContain(word);
    }
  });

  it('drops the waited-duration clause rather than rendering "0 minutes" when actualMinutes is absent', async () => {
    const out = getEmailTemplate('payment-charged', {
      recipientName: 'Jordan',
      expertName: 'Amara Okafor',
      amountAudMinor: 15_000,
      durationMinutes: 15,
      chargedOn: '20 July 2026',
      settlementShape: 'no_show_client',
      billingFloorMinutes: 15,
    });
    const html = clean(await render(out.component));
    expect(html).toContain('was there and waiting');
    expect(html).not.toContain('waited 0 minutes');
  });

  it('renders NOTHING extra on a held settlement or a live_capture receipt', async () => {
    const held = clean(
      await render(
        getEmailTemplate('payment-charged', {
          recipientName: 'Jordan',
          expertName: 'Amara Okafor',
          amountAudMinor: 15_000,
          durationMinutes: 45,
          chargedOn: '20 July 2026',
          settlementShape: 'held',
          actualMinutes: 45,
          billingFloorMinutes: 15,
        }).component
      )
    );
    expect(held).not.toContain('No one from your side joined');
    expect(held).not.toContain('minimum');
    // The shipped path — no BAL-412 fields at all.
    const legacy = clean(
      await render(
        getEmailTemplate('payment-charged', {
          recipientName: 'Jordan',
          expertName: 'Amara Okafor',
          amountAudMinor: 15_000,
          durationMinutes: 45,
          chargedOn: '20 July 2026',
        }).component
      )
    );
    expect(legacy).not.toContain('No one from your side joined');
    expect(legacy).not.toContain('minimum');
  });

  it('in-app: appends the clause on a no-show and nothing on a held settlement', () => {
    const noShow = getInAppTemplate('payment-charged', {
      amountAudMinor: 15_000,
      expertName: 'Amara Okafor',
      settlementShape: 'no_show_client',
      billingFloorMinutes: 15,
    });
    expect(noShow.body).toContain('No one from your side joined');
    expect(noShow.body).toContain('15-minute minimum');
    for (const word of BLAME_WORDS) {
      expect(noShow.body.toLowerCase()).not.toContain(word);
    }
    const held = getInAppTemplate('payment-charged', {
      amountAudMinor: 15_000,
      expertName: 'Amara Okafor',
      settlementShape: 'held',
    });
    expect(held.body).not.toContain('minimum');
  });
});

describe('BAL-412 F16 — payout-recorded carries the no-show accrual confirmation (expert lens)', () => {
  it('confirms the accrual at the minimum WITHOUT naming or blaming the absent party', async () => {
    const out = getEmailTemplate('payout-recorded', {
      recipientName: 'Amara',
      amountAudMinor: 11_250,
      durationMinutes: 15,
      recordedOn: '20 July 2026',
      settlementShape: 'no_show_client',
      actualMinutes: 18,
      billingFloorMinutes: 15,
    });
    const html = clean(await render(out.component));
    expect(html).toContain('settled as a no-show');
    expect(html).toContain('Your time still counts');
    expect(html).toContain('15-minute minimum');
    // ⚠ The expert-lens fee boundary AND the register rule agree here: never name the other party.
    expect(html.toLowerCase()).not.toContain('client');
    expect(html).not.toContain(CLIENT_CHARGE_SENTINEL);
    for (const word of BLAME_WORDS) {
      expect(html.toLowerCase()).not.toContain(word);
    }
  });

  it('renders NOTHING extra on a held settlement', async () => {
    const html = clean(
      await render(
        getEmailTemplate('payout-recorded', {
          recipientName: 'Amara',
          amountAudMinor: 11_250,
          durationMinutes: 45,
          recordedOn: '20 July 2026',
          settlementShape: 'held',
          actualMinutes: 45,
          billingFloorMinutes: 15,
        }).component
      )
    );
    expect(html).not.toContain('no-show');
    expect(html).not.toContain('minimum');
  });

  it('in-app: appends the accrual clause on a no-show, never says "client", and is silent otherwise', () => {
    const noShow = getInAppTemplate('payout-recorded', {
      amountAudMinor: 11_250,
      settlementShape: 'no_show_client',
      billingFloorMinutes: 15,
    });
    expect(noShow.body).toContain('Settled as a no-show');
    expect(noShow.body).toContain('15-minute minimum');
    expect(`${noShow.title} ${noShow.body}`.toLowerCase()).not.toContain('client');
    for (const word of BLAME_WORDS) {
      expect(noShow.body.toLowerCase()).not.toContain(word);
    }
    const held = getInAppTemplate('payout-recorded', {
      amountAudMinor: 11_250,
      settlementShape: 'held',
    });
    expect(held.body).not.toContain('minimum');
  });
});
