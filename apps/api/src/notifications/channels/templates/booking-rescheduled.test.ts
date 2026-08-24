import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import { bookingRescheduledSubject } from './booking-rescheduled.js';

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
 * (super-linear backtracking). Same rule as `booking-confirmed.test.ts`.
 */
function textOf(html: string): string {
  return clean(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BASE_DATA = {
  recipientName: 'Jordan',
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak',
  caseTitle: 'Salesforce CPQ rollout',
  previousScheduledStartIso: '2026-09-01T04:00:00.000Z',
  scheduledStartIso: '2026-09-08T06:30:00.000Z',
  durationMinutes: 30,
  engagementId: 'engagement-123',
};

describe('getEmailTemplate — booking-rescheduled-client', () => {
  it('names the expert PARTY, both windows, the minute count, and links to the case', async () => {
    const out = getEmailTemplate('booking-rescheduled-client', BASE_DATA);
    expect(out.subject).toBe('Your consultation with CloudPeak has moved');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('CloudPeak');
    expect(html).toContain('30 min');
    expect(html).toContain('Salesforce CPQ rollout');
    expect(html).toContain('/cases/engagement-123');
  });

  it('falls back to safe labels when the payload omits them', async () => {
    const out = getEmailTemplate('booking-rescheduled-client', {});
    expect(out.subject).toBe('Your consultation with Your expert has moved');
    const text = textOf(await render(out.component));
    expect(text).toContain('Hi there,');
    // Unparseable instants degrade to prose, never to "Invalid Date".
    expect(text).not.toContain('Invalid Date');
    expect(text).toContain('its previous time');
    expect(text).toContain('the scheduled time');
  });
});

describe('getEmailTemplate — booking-rescheduled-expert', () => {
  it('names the CLIENT COMPANY, not an invented individual', async () => {
    const out = getEmailTemplate('booking-rescheduled-expert', BASE_DATA);
    expect(out.subject).toBe('Northwind Industrial moved your consultation');
    const text = textOf(await render(out.component));
    expect(text).toContain('Northwind Industrial');
    expect(text).toContain('30 min');
  });

  it('falls back to "A client" when the company is absent', () => {
    const out = getEmailTemplate('booking-rescheduled-expert', {});
    expect(out.subject).toBe('A client moved your consultation');
  });
});

describe('booking-rescheduled — the invariants both halves must hold', () => {
  const RECIPIENTS = ['booking-rescheduled-client', 'booking-rescheduled-expert'] as const;

  // ADR-1044 §3: names cross the party boundary, ADDRESSES NEVER. The label fields carry
  // org/party names only; an `@` in the rendered copy would mean an address leaked through.
  it.each(RECIPIENTS)('%s renders no address other than Balo support', async (template) => {
    const html = await render(getEmailTemplate(template, BASE_DATA).component);
    const addresses = [...html.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(([match]) => match);

    // The `meeting-guest-emails.test.ts` precedent: the shared footer legitimately carries
    // Balo's OWN support address, so the assertion is an exact set — anything else appearing
    // here is a counterparty address that leaked through.
    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
  });

  // A reschedule moves no money. No rate, no total, no hold — fee concealment is load-bearing.
  it.each(RECIPIENTS)('%s states no money', async (template) => {
    const text = textOf(await render(getEmailTemplate(template, BASE_DATA).component));
    expect(text).not.toContain('$');
    expect(text.toLowerCase()).not.toContain('hold');
    expect(text.toLowerCase()).not.toContain('rate');
  });

  /**
   * D14 — THE CALENDAR CLAIM. The Apiroc amend is a RETRYING BULLMQ JOB that fires AFTER this
   * email is published, and there is no client-side ICS at all in Slice A. So neither half may
   * claim any calendar was updated: at send time it demonstrably has not been.
   */
  it.each(RECIPIENTS)('%s claims no calendar was updated', async (template) => {
    const text = textOf(
      await render(getEmailTemplate(template, BASE_DATA).component)
    ).toLowerCase();
    expect(text).not.toContain('calendar has been updated');
    expect(text).not.toContain('updated your calendar');
    expect(text).not.toContain('added to your calendar');
  });

  // CLAUDE.md: gender-neutral copy — never a gendered pronoun for a client or an expert.
  it.each(RECIPIENTS)('%s uses no gendered pronouns', async (template) => {
    const text = textOf(await render(getEmailTemplate(template, BASE_DATA).component));
    expect(text).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });

  // B2 pinned the duration server-side, so "same length" is now a TRUE statement rather than
  // the false reassurance it was before the fix. Pin the claim so a future resize-capable
  // reschedule cannot silently leave this copy lying.
  it.each(RECIPIENTS)('%s says the length is unchanged', async (template) => {
    const text = textOf(await render(getEmailTemplate(template, BASE_DATA).component));
    expect(text).toContain('same length');
  });
});

describe('bookingRescheduledSubject', () => {
  // The subject is shared with the registry so the two cannot drift into different strings.
  it('is the same function the registry uses for each recipient', () => {
    expect(bookingRescheduledSubject('client', 'CloudPeak')).toBe(
      getEmailTemplate('booking-rescheduled-client', BASE_DATA).subject
    );
    expect(bookingRescheduledSubject('expert', 'Northwind Industrial')).toBe(
      getEmailTemplate('booking-rescheduled-expert', BASE_DATA).subject
    );
  });
});
