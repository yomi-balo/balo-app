import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';

// ⚠ `.ts`, NOT `.tsx` — apps/api's vitest globs `src/**/*.{test,spec}.ts` only, so a `.test.tsx`
// never runs and reports green (memory `reference_api_vitest_only_globs_test_ts`).

function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

/** The message as a HUMAN reads it — see `booking-confirmed.test.ts` for the full rationale. */
function textOf(html: string): string {
  return clean(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHARE_DATA = {
  recipientName: 'Jordan',
  expertPersonName: 'Dana Okafor',
  expertPartyLabel: 'CloudPeak',
  requestTitle: 'Salesforce CPQ rollout',
  requestId: 'request-123',
};

const BOOKED_DATA = {
  recipientName: 'Jordan',
  // Retrospective attribution needs BOTH halves — the expert-facing copy names the PERSON
  // "@ company" on first mention (CLAUDE.md; round-1 MAJOR UX).
  clientPersonName: 'Sam Reilly',
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak',
  requestTitle: 'Salesforce CPQ rollout',
  requestId: 'request-123',
  scheduledStartIso: '2026-09-01T04:00:00.000Z',
  durationMinutes: 30,
  guestCount: 0,
  provisioned: true,
  joinPath: '/meetings/meeting-456/call',
};

describe('getEmailTemplate — availability-shared-client', () => {
  it('names the person "@ party", states the request title, and links the conversation', async () => {
    const out = getEmailTemplate('availability-shared-client', SHARE_DATA);
    expect(out.subject).toBe('Dana Okafor @ CloudPeak is free — pick a time');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('Dana Okafor @ CloudPeak');
    expect(html).toContain('Salesforce CPQ rollout');
    expect(html).toContain('/projects/request-123');
  });

  /**
   * ⚠ INDEPENDENT EXPERTS ARE A FIRST-CLASS COHORT, NOT AN EDGE CASE (round-1 W1). For one,
   * `expertPartyDisplayName` returns the PERSON'S OWN NAME as the party label — so the previous
   * hand-concatenated `` `${person} @ ${party}` `` rendered the SUBJECT LINE as
   * *"Dana Okafor @ Dana Okafor is free — pick a time"*.
   */
  it('an INDEPENDENT expert is named once — never "Dana Okafor @ Dana Okafor"', async () => {
    const out = getEmailTemplate('availability-shared-client', {
      ...SHARE_DATA,
      expertPartyLabel: 'Dana Okafor',
    });
    expect(out.subject).toBe('Dana Okafor is free — pick a time');
    const html = clean(await render(out.component));
    expect(html).not.toContain('Dana Okafor @ Dana Okafor');
    expect(html).toContain('Dana Okafor shared their availability');
  });

  it('a missing party label degrades to the bare person name — never "their agency"', async () => {
    const out = getEmailTemplate('availability-shared-client', {
      ...SHARE_DATA,
      expertPartyLabel: undefined,
    });
    expect(out.subject).toBe('Dana Okafor is free — pick a time');
    const html = clean(await render(out.component));
    expect(html).not.toContain('their agency');
  });

  it('carries no email address but support@getbalo.com, and no money figure', async () => {
    const html = clean(
      await render(getEmailTemplate('availability-shared-client', SHARE_DATA).component)
    );
    const addresses = html.match(/[\w.-]{1,64}@[\w-]{1,63}\.[a-z]{2,}/gi) ?? [];
    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
    const text = textOf(html);
    expect(text).not.toContain('$');
    expect(text).not.toContain('/min');
  });

  it('is gender-neutral — no gendered pronoun anywhere', async () => {
    const html = clean(
      await render(getEmailTemplate('availability-shared-client', SHARE_DATA).component)
    );
    expect(html.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});

describe('getEmailTemplate — intro-call-booked-client', () => {
  it('names the expert party, states the minute count and "free", and links the conversation', async () => {
    const out = getEmailTemplate('intro-call-booked-client', BOOKED_DATA);
    expect(out.subject).toBe('Your intro call with CloudPeak is confirmed');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('CloudPeak');
    expect(html).toContain('30 min');
    expect(html.toLowerCase()).toContain('free');
    expect(html).toContain('/projects/request-123');
  });

  it('includes the join link when provisioned, suppresses it and promises nothing otherwise', async () => {
    const provisioned = clean(
      await render(getEmailTemplate('intro-call-booked-client', BOOKED_DATA).component)
    );
    expect(provisioned).toContain('/meetings/meeting-456/call');

    const unprovisioned = textOf(
      await render(
        getEmailTemplate('intro-call-booked-client', { ...BOOKED_DATA, provisioned: false })
          .component
      )
    );
    expect(unprovisioned).not.toContain('/meetings/meeting-456/call');
    expect(unprovisioned).toContain('our team has been alerted');
    expect(unprovisioned).not.toMatch(/will be ready|on its way|by email/i);
  });

  it('mentions guests when guestCount is positive, omits it at zero', async () => {
    const withGuests = clean(
      await render(
        getEmailTemplate('intro-call-booked-client', { ...BOOKED_DATA, guestCount: 2 }).component
      )
    );
    expect(withGuests).toContain('2 guests');

    const withoutGuests = clean(
      await render(
        getEmailTemplate('intro-call-booked-client', { ...BOOKED_DATA, guestCount: 0 }).component
      )
    );
    expect(withoutGuests).not.toContain('guest');
  });

  it('carries no email address but support@getbalo.com, and no rate/total figure — Ruling 2', async () => {
    const html = clean(
      await render(getEmailTemplate('intro-call-booked-client', BOOKED_DATA).component)
    );
    const addresses = html.match(/[\w.-]{1,64}@[\w-]{1,63}\.[a-z]{2,}/gi) ?? [];
    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
    const text = textOf(html);
    expect(text).not.toContain('$');
    expect(text).not.toContain('/min');
  });

  it('is gender-neutral — no gendered pronoun anywhere', async () => {
    const html = clean(
      await render(getEmailTemplate('intro-call-booked-client', BOOKED_DATA).component)
    );
    expect(html.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});

describe('getEmailTemplate — intro-call-booked-expert', () => {
  it('RETROSPECTIVE: names the PERSON "@ company" and links the conversation', async () => {
    const out = getEmailTemplate('intro-call-booked-expert', BOOKED_DATA);
    expect(out.subject).toBe('Sam Reilly @ Northwind Industrial booked an intro call with you');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('Sam Reilly @ Northwind Industrial');
    expect(html).toContain('/projects/request-123');
  });

  it('a client with no company on file degrades to the bare person name', async () => {
    const out = getEmailTemplate('intro-call-booked-expert', {
      ...BOOKED_DATA,
      clientCompanyName: undefined,
    });
    expect(out.subject).toBe('Sam Reilly booked an intro call with you');
  });

  it('suppresses the join link when provisioned is false', async () => {
    const html = clean(
      await render(
        getEmailTemplate('intro-call-booked-expert', { ...BOOKED_DATA, provisioned: false })
          .component
      )
    );
    expect(html).not.toContain('/meetings/meeting-456/call');
  });

  it('carries no email address but support@getbalo.com, and no rate/total figure', async () => {
    const html = clean(
      await render(getEmailTemplate('intro-call-booked-expert', BOOKED_DATA).component)
    );
    const addresses = html.match(/[\w.-]{1,64}@[\w-]{1,63}\.[a-z]{2,}/gi) ?? [];
    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
    const text = textOf(html);
    expect(text).not.toContain('$');
    expect(text).not.toContain('/min');
  });

  it('is gender-neutral — no gendered pronoun anywhere', async () => {
    const html = clean(
      await render(getEmailTemplate('intro-call-booked-expert', BOOKED_DATA).component)
    );
    expect(html.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});

describe('getEmailTemplate — intro-call-booked callKind (BAL-616)', () => {
  const CALL_DATA = { ...BOOKED_DATA, callKind: 'call' };

  it('client: "call" copy in the subject, heading and body, and never "intro"', async () => {
    const out = getEmailTemplate('intro-call-booked-client', CALL_DATA);
    expect(out.subject).toBe('Your call with CloudPeak is confirmed');
    const text = textOf(await render(out.component)).replaceAll('&quot;', '"');
    expect(text).toContain('Your call is confirmed');
    expect(text).toContain('Your call with CloudPeak is confirmed for');
    expect(text).toContain(
      'Free — calls on this project never cost credit. This is about "Salesforce CPQ rollout".'
    );
    expect(`${out.subject} ${text}`.toLowerCase()).not.toContain('intro');
  });

  it('expert: "call" copy in the subject, heading and body, and never "intro"', async () => {
    const out = getEmailTemplate('intro-call-booked-expert', CALL_DATA);
    expect(out.subject).toBe('Sam Reilly @ Northwind Industrial booked a call with you');
    const text = textOf(await render(out.component));
    expect(text).toContain('A new call was booked');
    expect(text).toContain('Sam Reilly @ Northwind Industrial booked a call with you for');
    expect(`${out.subject} ${text}`.toLowerCase()).not.toContain('intro');
  });

  it.each(['intro-call-booked-client', 'intro-call-booked-expert'] as const)(
    '%s: an absent or unknown callKind renders the intro copy',
    async (template) => {
      for (const callKind of [undefined, 'other']) {
        const out = getEmailTemplate(template, { ...BOOKED_DATA, callKind });
        const text = textOf(await render(out.component));
        expect(out.subject).toContain('intro call');
        expect(text).toContain('Free — no charge, no commitment.');
      }
    }
  );
});
