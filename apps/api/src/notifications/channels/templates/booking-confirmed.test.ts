import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';

function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

/**
 * The message as a HUMAN reads it: comments, `<style>` blocks and tags removed.
 *
 * ⚠ NEEDED FOR THE MONEY SWEEP SPECIFICALLY (the `meeting-guest-emails.test.ts` precedent).
 * React-Email emits `<!--$-->` / `<!--/$-->` Suspense markers and inline `style` attributes
 * full of `#`-colours and `linear-gradient`, so a raw `expect(html).not.toContain('$')` fails
 * on framework plumbing rather than on copy.
 *
 * ⚠ THE TAG REGEX IS `/<[^<>]*>/g`, NOT `/<[^>]*>/g` — the latter is SonarCloud S5852
 * (super-linear backtracking on hostile input).
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
  scheduledStartIso: '2026-09-01T04:00:00.000Z',
  durationMinutes: 30,
  isNewCase: true,
  priorConsultationCount: 0,
  guestCount: 0,
  provisioned: true,
  engagementId: 'engagement-123',
  joinPath: '/join/m/meeting-456',
};

describe('getEmailTemplate — booking-confirmed-client', () => {
  it('names the expert party, states the minute count, and links to the case', async () => {
    const out = getEmailTemplate('booking-confirmed-client', BASE_DATA);
    expect(out.subject).toBe('Your consultation with CloudPeak is confirmed');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('CloudPeak');
    expect(html).toContain('30 min');
    expect(html).toContain('/cases/engagement-123');
  });

  it('uses the attach copy and prior-consultation count when isNewCase is false', async () => {
    const out = getEmailTemplate('booking-confirmed-client', {
      ...BASE_DATA,
      isNewCase: false,
      priorConsultationCount: 2,
    });
    expect(out.subject).toBe('Another consultation with CloudPeak is confirmed');
    const html = clean(await render(out.component));
    expect(html).toContain('2 consultations');
  });

  it('includes the join link when provisioned', async () => {
    const out = getEmailTemplate('booking-confirmed-client', { ...BASE_DATA, provisioned: true });
    const html = clean(await render(out.component));
    expect(html).toContain('/join/m/meeting-456');
  });

  it('suppresses the join link when provisioned is false, and promises nothing (M6)', async () => {
    const out = getEmailTemplate('booking-confirmed-client', { ...BASE_DATA, provisioned: false });
    const text = textOf(await render(out.component));
    expect(text).not.toContain('/join/m/meeting-456');
    // M6 — no repair sweep, no retry job and no provision-on-join exists, so this branch may
    // state only what is TRUE: the time is held and the failure was recorded.
    expect(text).toContain('our team has been alerted');
    expect(text).not.toMatch(/will be ready|on its way|by email/i);
  });

  it('mentions guests when guestCount is positive, omits it at zero', async () => {
    const withGuests = clean(
      await render(
        getEmailTemplate('booking-confirmed-client', { ...BASE_DATA, guestCount: 2 }).component
      )
    );
    expect(withGuests).toContain('2 guests');

    const withoutGuests = clean(
      await render(
        getEmailTemplate('booking-confirmed-client', { ...BASE_DATA, guestCount: 0 }).component
      )
    );
    expect(withoutGuests).not.toContain('guest');
  });

  it('carries no email address but support@getbalo.com, no rate/total figure, and no calendar claim', async () => {
    const html = clean(
      await render(getEmailTemplate('booking-confirmed-client', BASE_DATA).component)
    );
    // The bounded `[\w.-]{1,64}` local part cannot backtrack catastrophically (S5852).
    const addresses = html.match(/[\w.-]{1,64}@[\w-]{1,63}\.[a-z]{2,}/gi) ?? [];
    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
    const text = textOf(html);
    expect(text).not.toContain('$');
    expect(text).not.toContain('/min');
    expect(text.toLowerCase()).not.toContain('calendar');
  });

  it('is gender-neutral — no gendered pronoun anywhere', async () => {
    const html = clean(
      await render(getEmailTemplate('booking-confirmed-client', BASE_DATA).component)
    );
    expect(html.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});

describe('getEmailTemplate — booking-confirmed-expert', () => {
  it('names the client company and links to the case', async () => {
    const out = getEmailTemplate('booking-confirmed-expert', BASE_DATA);
    expect(out.subject).toBe('Northwind Industrial booked a consultation with you');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('Northwind Industrial');
    expect(html).toContain('/cases/engagement-123');
  });

  it('uses the attach copy when isNewCase is false', async () => {
    const out = getEmailTemplate('booking-confirmed-expert', { ...BASE_DATA, isNewCase: false });
    expect(out.subject).toBe('Northwind Industrial booked another consultation with you');
  });

  it('suppresses the join link when provisioned is false', async () => {
    const html = clean(
      await render(
        getEmailTemplate('booking-confirmed-expert', { ...BASE_DATA, provisioned: false }).component
      )
    );
    expect(html).not.toContain('/join/m/meeting-456');
  });

  it('carries no email address but support@getbalo.com, and no rate/total figure', async () => {
    const html = clean(
      await render(getEmailTemplate('booking-confirmed-expert', BASE_DATA).component)
    );
    const addresses = html.match(/[\w.-]{1,64}@[\w-]{1,63}\.[a-z]{2,}/gi) ?? [];
    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
    const text = textOf(html);
    expect(text).not.toContain('$');
    expect(text).not.toContain('/min');
  });

  it('is gender-neutral — no gendered pronoun anywhere', async () => {
    const html = clean(
      await render(getEmailTemplate('booking-confirmed-expert', BASE_DATA).component)
    );
    expect(html.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});
