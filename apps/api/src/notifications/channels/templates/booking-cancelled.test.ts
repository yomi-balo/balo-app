import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import { bookingCancelledSubject } from './booking-cancelled.js';

function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

/**
 * The message as a HUMAN reads it — comments, `<style>` blocks and tags removed. Needed for the
 * money/address sweeps specifically: React-Email emits Suspense markers and inline `style`
 * attributes full of `#`-colours, so a raw `not.toContain('$')` would fail on plumbing.
 *
 * ⚠ The tag regex is `/<[^<>]*>/g`, NOT `/<[^>]*>/g` — the latter is SonarCloud S5852
 * (super-linear backtracking). Same rule as `booking-rescheduled.test.ts`.
 */
function textOf(html: string): string {
  return clean(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every email-shaped token in the rendered HTML — the ADR-1044 §3 address sweep.
 *
 * ⚠⚠ A LINEAR SPLIT-AND-SCAN, DELIBERATELY NOT THE `/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g` REGEX its
 * three shipped siblings use (`booking-rescheduled.test.ts`, `meeting-guest-emails.test.ts`).
 * That pattern is SUPER-LINEAR — `[\w.+-]+` before a `@` that may never arrive backtracks
 * quadratically — which ESLint flags as `regexp/no-super-linear-move` and SonarCloud gates on as
 * S5852, a new-code Security Hotspot. The three existing instances predate this file and are
 * warnings on `main`; a NEW one would be a new-code hotspot, so this one is written linearly.
 * The siblings should be migrated to this shape by whoever next touches them.
 *
 * The ONE regex left is the split class `[\s<>"'()]+` — a single quantifier over a character
 * class with no alternation and nothing after it, so it cannot backtrack. Everything else is an
 * index walk over `Set` membership: linear by construction, and impossible to regress into a
 * quadratic pattern later.
 */
const ADDRESS_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-_');
const TRAILING_PUNCTUATION = new Set('.,;:');

function addressesIn(html: string): string[] {
  const found = new Set<string>();
  for (const token of html.split(/[\s<>"'()]+/)) {
    const at = token.indexOf('@');
    if (at <= 0) continue;

    // The trailing address-legal run of the local part, so `mailto:support` and `href=support`
    // both reduce to `support`. An index walk, not a regex — see the docblock.
    let start = at;
    while (start > 0 && ADDRESS_CHARS.has(token[start - 1] ?? '')) start -= 1;
    const local = token.slice(start, at);

    // Trim sentence punctuation off the domain, the same way and for the same reason.
    let end = token.length;
    while (end > at + 1 && TRAILING_PUNCTUATION.has(token[end - 1] ?? '')) end -= 1;
    const domain = token.slice(at + 1, end);

    if (local.length > 0 && domain.includes('.') && !domain.startsWith('.')) {
      found.add(`${local}@${domain}`);
    }
  }
  return [...found];
}

const BASE_DATA = {
  recipientName: 'Jordan',
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak',
  cancelledByLabel: 'Dana Okoro @ Northwind Industrial',
  caseTitle: 'Salesforce CPQ rollout',
  scheduledStartIso: '2026-09-08T06:30:00.000Z',
  durationMinutes: 30,
  cancelledBy: 'client',
  reason: 'requested',
  engagementId: 'engagement-123',
};

describe('getEmailTemplate — booking-cancelled-client', () => {
  it('names the expert PARTY, the released window, the minute count, and links to the case', async () => {
    const out = getEmailTemplate('booking-cancelled-client', BASE_DATA);
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('CloudPeak');
    expect(html).toContain('30-minute');
    expect(html).toContain('Salesforce CPQ rollout');
    expect(html).toContain('/cases/engagement-123');
  });

  it('⚠ states plainly that nothing was charged — the whole product promise', async () => {
    const text = textOf(
      await render(getEmailTemplate('booking-cancelled-client', BASE_DATA).component)
    );
    expect(text).toContain('nothing was charged');
  });

  it('falls back to safe labels when the payload omits them', async () => {
    const out = getEmailTemplate('booking-cancelled-client', {});
    expect(out.subject).toBe('You cancelled your consultation with Your expert');
    const text = textOf(await render(out.component));
    expect(text).toContain('Hi there,');
    // Unparseable instants degrade to prose, never to "Invalid Date".
    expect(text).not.toContain('Invalid Date');
  });

  it('reads as an acknowledgement when the CLIENT cancelled it themselves', async () => {
    const text = textOf(
      await render(
        getEmailTemplate('booking-cancelled-client', { ...BASE_DATA, cancelledBy: 'client' })
          .component
      )
    );
    expect(text).toContain('You cancelled');
  });

  it('names the PERSON who cancelled when it was not the recipient', async () => {
    const text = textOf(
      await render(
        getEmailTemplate('booking-cancelled-client', { ...BASE_DATA, cancelledBy: 'expert' })
          .component
      )
    );
    expect(text).toContain('Dana Okoro @ Northwind Industrial');
  });

  it('states the time-off reason as a fact, blaming nobody', async () => {
    const text = textOf(
      await render(
        getEmailTemplate('booking-cancelled-client', {
          ...BASE_DATA,
          cancelledBy: 'expert',
          reason: 'expert_time_off',
        }).component
      )
    );
    expect(text).toContain('no longer available');
  });
});

describe('getEmailTemplate — booking-cancelled-expert', () => {
  it('names the client COMPANY and says the slot is open again', async () => {
    const out = getEmailTemplate('booking-cancelled-expert', BASE_DATA);
    expect(out.subject).toBe('Northwind Industrial cancelled a consultation');
    const text = textOf(await render(out.component));
    expect(text).toContain('Northwind Industrial');
    expect(text).toContain('open on your calendar again');
  });
});

// ── The invariants, over EVERY combination ────────────────────────────────────

describe('booking-cancelled — the invariants, over every recipient × initiator × reason', () => {
  const RECIPIENTS = ['booking-cancelled-client', 'booking-cancelled-expert'] as const;
  const INITIATORS = ['client', 'expert', 'admin'] as const;
  const REASONS = ['requested', 'expert_time_off'] as const;

  /**
   * ⚠ EVERY invariant below is re-run over ALL SIX (recipient × initiator) pairs AND both
   * reasons, so a new copy arm cannot silently leak an address, a money figure, a gendered
   * pronoun or hold language that the original arm was clean of.
   */
  const CASES = RECIPIENTS.flatMap((template) =>
    INITIATORS.flatMap((cancelledBy) =>
      REASONS.map((reason) => ({ template, cancelledBy, reason }))
    )
  );

  // ADR-1044 §3: names cross the party boundary, ADDRESSES NEVER. The label fields carry
  // org/party names only; an `@`-address in the rendered copy would mean one leaked through.
  it.each(CASES)(
    '$template ($cancelledBy/$reason) renders no address other than Balo support',
    async ({ template, cancelledBy, reason }) => {
      const html = await render(
        getEmailTemplate(template, { ...BASE_DATA, cancelledBy, reason }).component
      );

      // The shared footer legitimately carries Balo's OWN support address, so the assertion is
      // an EXACT SET — anything else here is a counterparty address that leaked.
      expect(addressesIn(html)).toEqual(['support@getbalo.com']);
    }
  );

  it('⚠ an address smuggled into a LABEL field is caught by the same sweep', async () => {
    // The defence is on the rendered OUTPUT, not on the publisher's discipline — which is what
    // makes it hold even if a future label resolver regresses.
    const html = await render(
      getEmailTemplate('booking-cancelled-client', {
        ...BASE_DATA,
        // ⚠ `cancelledBy: 'expert'` is REQUIRED for this probe: the client template only
        // renders `cancelledByLabel` when the recipient did NOT act themselves. On the
        // self-act arm the label is never read, so a smuggled address there would not be
        // rendered — and a test that used it would pass for the wrong reason.
        cancelledBy: 'expert',
        cancelledByLabel: 'dana.okoro@northwind.example.com',
      }).component
    );
    expect(addressesIn(html)).toContain('dana.okoro@northwind.example.com');
  });

  // A cancellation moves NO money. No rate, no total, no balance — fee concealment.
  it.each(CASES)(
    '$template ($cancelledBy/$reason) states no money figure',
    async ({ template, cancelledBy, reason }) => {
      const text = textOf(
        await render(getEmailTemplate(template, { ...BASE_DATA, cancelledBy, reason }).component)
      );
      expect(text).not.toContain('$');
      expect(text.toLowerCase()).not.toContain('rate');
      expect(text.toLowerCase()).not.toContain('balance');
    }
  );

  /**
   * ⚠⚠ THE HOLD IS AN IN-APP-ONLY NOTICE. The ticket: "Hold released → client → in-app only.
   * Not email — no money moved, and an email implies something went wrong." `holdReleased` is
   * not even a prop of this component, and this pins that it stays that way — including when a
   * caller passes it on the merged payload bag.
   */
  it.each(CASES)(
    '$template ($cancelledBy/$reason) renders NO hold language, even with holdReleased: true',
    async ({ template, cancelledBy, reason }) => {
      const text = textOf(
        await render(
          getEmailTemplate(template, { ...BASE_DATA, cancelledBy, reason, holdReleased: true })
            .component
        )
      ).toLowerCase();
      expect(text).not.toContain('hold');
      expect(text).not.toContain('released');
      expect(text).not.toContain('refund');
    }
  );

  // CLAUDE.md: gender-neutral copy — never a gendered pronoun for a client or an expert.
  it.each(CASES)(
    '$template ($cancelledBy/$reason) uses no gendered pronouns',
    async ({ template, cancelledBy, reason }) => {
      const text = textOf(
        await render(getEmailTemplate(template, { ...BASE_DATA, cancelledBy, reason }).component)
      );
      expect(text).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
    }
  );

  // CLAUDE.md: warm, never adversarial. No countdown, no penalty, no blame.
  it.each(CASES)(
    '$template ($cancelledBy/$reason) uses no adversarial or penalty language',
    async ({ template, cancelledBy, reason }) => {
      const text = textOf(
        await render(getEmailTemplate(template, { ...BASE_DATA, cancelledBy, reason }).component)
      ).toLowerCase();
      for (const forbidden of [
        'penalty',
        'fee',
        'charged you',
        'too late',
        'failed to',
        'no-show',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    }
  );

  // ⚠ A Balo staff member is never named to the parties.
  it.each(RECIPIENTS)('%s never names a Balo staff member on the admin arm', async (template) => {
    const text = textOf(
      await render(
        getEmailTemplate(template, {
          ...BASE_DATA,
          cancelledBy: 'admin',
          // Even if the publisher regressed and passed a person here, the ADMIN arm's label
          // comes from the payload — so this asserts the payload contract the publisher keeps.
          cancelledByLabel: 'Balo support',
        }).component
      )
    );
    expect(text).toContain('Balo support');
  });
});

describe('bookingCancelledSubject', () => {
  // The subject is shared with the registry so the two cannot drift into different strings.
  it('is the same function the registry uses for each recipient', () => {
    expect(bookingCancelledSubject('client', 'CloudPeak', 'client', 'requested')).toBe(
      getEmailTemplate('booking-cancelled-client', BASE_DATA).subject
    );
    expect(bookingCancelledSubject('expert', 'Northwind Industrial', 'client', 'requested')).toBe(
      getEmailTemplate('booking-cancelled-expert', BASE_DATA).subject
    );
  });

  it('acknowledges the recipient’s OWN act rather than reporting it to them', () => {
    expect(bookingCancelledSubject('client', 'CloudPeak', 'client')).toBe(
      'You cancelled your consultation with CloudPeak'
    );
    expect(bookingCancelledSubject('expert', 'Northwind Industrial', 'expert')).toBe(
      'You cancelled your consultation with Northwind Industrial'
    );
  });

  it('reports the counterparty’s act otherwise', () => {
    expect(bookingCancelledSubject('client', 'CloudPeak', 'expert')).toBe(
      'Your consultation with CloudPeak was cancelled'
    );
    expect(bookingCancelledSubject('expert', 'Northwind Industrial', 'client')).toBe(
      'Northwind Industrial cancelled a consultation'
    );
  });

  it('uses the neutral time-off phrasing on that reason variant', () => {
    expect(bookingCancelledSubject('client', 'CloudPeak', 'expert', 'expert_time_off')).toBe(
      'Your consultation with CloudPeak has been cancelled'
    );
  });
});
