import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import {
  rescheduleProposalSentSubject,
  rescheduleProposalDeclinedSubject,
} from './reschedule-proposal.js';

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

const SENT_DATA = {
  recipientName: 'Jordan',
  expertPersonLabel: 'Dana Reyes @ CloudPeak',
  caseTitle: 'Salesforce CPQ rollout',
  originalScheduledStartIso: '2026-09-01T04:00:00.000Z',
  optionStartIsos: [
    '2026-09-02T10:00:00.000Z',
    '2026-09-03T14:00:00.000Z',
    '2026-09-04T18:00:00.000Z',
  ],
  durationMinutes: 30,
  engagementId: 'engagement-123',
};

const DECLINED_DATA = {
  recipientName: 'Dana',
  declinedByLabel: 'Priya Shah @ Northwind Industrial',
  caseTitle: 'Salesforce CPQ rollout',
  originalScheduledStartIso: '2026-09-01T04:00:00.000Z',
  durationMinutes: 30,
  engagementId: 'engagement-123',
};

describe('getEmailTemplate — reschedule-proposal-sent', () => {
  it('names the expert PERSON, the original window, the options, and links to the case', async () => {
    const out = getEmailTemplate('reschedule-proposal-sent', SENT_DATA);
    expect(out.subject).toBe('Dana Reyes @ CloudPeak suggested a new time');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Jordan,');
    expect(html).toContain('Dana Reyes @ CloudPeak');
    expect(html).toContain('30 min');
    expect(html).toContain('Salesforce CPQ rollout');
    expect(html).toContain('/cases/engagement-123');
  });

  it('falls back to safe labels when the payload omits them', async () => {
    const out = getEmailTemplate('reschedule-proposal-sent', {});
    expect(out.subject).toBe('Your expert suggested a new time');
    const text = textOf(await render(out.component));
    expect(text).toContain('Hi there,');
    // Unparseable instants degrade to prose, never to "Invalid Date".
    expect(text).not.toContain('Invalid Date');
    expect(text).toContain('its scheduled time');
  });

  it('renders 1, 2, and 3 options', async () => {
    for (const count of [1, 2, 3] as const) {
      const optionStartIsos = SENT_DATA.optionStartIsos.slice(0, count);
      const text = textOf(
        await render(
          getEmailTemplate('reschedule-proposal-sent', { ...SENT_DATA, optionStartIsos }).component
        )
      );
      // Every provided option's window renders; an unparseable one degrades to prose.
      expect(text).not.toContain('Invalid Date');
      expect(text).toContain('Other times that work for them');
    }
  });

  // CONSIDER item — "a few other times" for a 1-option proposal. `case-nudge.tsx:240` already
  // gets the singular right; this pins the email to the same rule.
  it('says "another time" for a 1-option proposal, not "a few other times"', async () => {
    const text = textOf(
      await render(
        getEmailTemplate('reschedule-proposal-sent', {
          ...SENT_DATA,
          optionStartIsos: SENT_DATA.optionStartIsos.slice(0, 1),
        }).component
      )
    );
    expect(text).toContain('suggested another time');
    expect(text).not.toContain('a few other times');
  });

  it('says "a few other times" for a 2+-option proposal', async () => {
    const text = textOf(
      await render(getEmailTemplate('reschedule-proposal-sent', SENT_DATA).component)
    );
    expect(text).toContain('suggested a few other times');
  });

  it('degrades an unparseable option instant to prose, never "Invalid Date"', async () => {
    const text = textOf(
      await render(
        getEmailTemplate('reschedule-proposal-sent', {
          ...SENT_DATA,
          optionStartIsos: ['not-a-real-instant'],
        }).component
      )
    );
    expect(text).not.toContain('Invalid Date');
    expect(text).toContain('a new time');
  });
});

describe('getEmailTemplate — reschedule-proposal-declined', () => {
  it('names the person who declined, with "@ company" on first mention', async () => {
    const out = getEmailTemplate('reschedule-proposal-declined', DECLINED_DATA);
    expect(out.subject).toBe('Priya Shah @ Northwind Industrial kept the original time');
    const text = textOf(await render(out.component));
    expect(text).toContain('Priya Shah @ Northwind Industrial');
    expect(text).toContain('30 min');
    expect(text).toContain('Salesforce CPQ rollout');
  });

  it('falls back to "The client" when the label is absent', () => {
    const out = getEmailTemplate('reschedule-proposal-declined', {});
    expect(out.subject).toBe('The client kept the original time');
  });

  it('degrades an unparseable original instant to prose, never "Invalid Date"', async () => {
    const text = textOf(
      await render(
        getEmailTemplate('reschedule-proposal-declined', {
          ...DECLINED_DATA,
          originalScheduledStartIso: 'not-a-real-instant',
        }).component
      )
    );
    expect(text).not.toContain('Invalid Date');
    expect(text).toContain('the original time');
  });
});

describe('reschedule-proposal — the invariants both templates must hold', () => {
  const CASES = [
    { template: 'reschedule-proposal-sent', data: SENT_DATA, label: SENT_DATA.expertPersonLabel },
    {
      template: 'reschedule-proposal-declined',
      data: DECLINED_DATA,
      label: DECLINED_DATA.declinedByLabel,
    },
  ] as const;

  // ADR-1044 §3: names cross the party boundary, ADDRESSES NEVER. The label fields carry
  // party/person names only; an `@`-address in the rendered copy would mean an address leaked
  // through.
  it.each(CASES)(
    '$template renders no address other than Balo support',
    async ({ template, data }) => {
      const html = await render(getEmailTemplate(template, data).component);
      const addresses = [...html.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(([match]) => match);

      // The `meeting-guest-emails.test.ts` / `booking-rescheduled.test.ts` precedent: the shared
      // footer legitimately carries Balo's OWN support address, so the assertion is an exact set —
      // anything else appearing here is a counterparty address that leaked through.
      expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
    }
  );

  // Plan-mandated: the LABEL VALUE ITSELF — `expertPersonLabel` / `declinedByLabel` — must never
  // be an email address ("Name @ Org" is not "user@domain.tld"; this pins that shape directly,
  // independent of the whole-render address sweep above).
  it.each(CASES)('$template — the label prop itself is not an email address', ({ label }) => {
    expect(label).not.toMatch(/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/);
  });

  // A proposal — and a decline of one — moves no money. No rate, no total, no hold.
  it.each(CASES)('$template states no money', async ({ template, data }) => {
    const text = textOf(await render(getEmailTemplate(template, data).component));
    expect(text).not.toContain('$');
    expect(text.toLowerCase()).not.toContain('hold');
    expect(text.toLowerCase()).not.toContain('rate');
  });

  // Nothing has moved yet — a proposal is a soft ask, not a booking.
  it.each(CASES)('$template claims no calendar was updated', async ({ template, data }) => {
    const text = textOf(await render(getEmailTemplate(template, data).component)).toLowerCase();
    expect(text).not.toContain('calendar has been updated');
    expect(text).not.toContain('updated your calendar');
    expect(text).not.toContain('added to your calendar');
  });

  // CLAUDE.md: gender-neutral copy — never a gendered pronoun for a client or an expert.
  it.each(CASES)('$template uses no gendered pronouns', async ({ template, data }) => {
    const text = textOf(await render(getEmailTemplate(template, data).component));
    expect(text).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

describe('rescheduleProposalSentSubject / rescheduleProposalDeclinedSubject', () => {
  // The subject is shared with the registry so the two cannot drift into different strings.
  it('is the same function the registry uses', () => {
    expect(rescheduleProposalSentSubject('Dana Reyes @ CloudPeak')).toBe(
      getEmailTemplate('reschedule-proposal-sent', SENT_DATA).subject
    );
    expect(rescheduleProposalDeclinedSubject('Priya Shah @ Northwind Industrial')).toBe(
      getEmailTemplate('reschedule-proposal-declined', DECLINED_DATA).subject
    );
  });
});
