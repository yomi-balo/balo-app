import { describe, expect, it } from 'vitest';
import { render } from '@react-email/render';
import {
  MeetingGuestInvitedEmail,
  MeetingGuestRemovedEmail,
  formatMeetingWindowUtc,
} from './meeting-guest-emails.js';
import { getEmailTemplate } from './index.js';

/**
 * BAL-408 — the two GUEST-FACING emails.
 *
 * ⚠ THIS FILE HAS NO TIMEZONE DEPENDENCE, BY CONSTRUCTION. `formatMeetingWindowUtc` pins
 * `timeZone: 'UTC'` on both `Intl.DateTimeFormat` instances, so every expectation below
 * holds on a `TZ=UTC` CI shell and on a `TZ=Australia/Melbourne` laptop alike. There is
 * deliberately no `TZ` guard, no `vi.setSystemTime` and no offset arithmetic — if any of
 * those ever becomes necessary, the UTC pinning has regressed.
 *
 * ⚠ THE MONTH IS MATCHED AS `Sept?`, NOT AS A FIXED STRING, AND THAT IS NOT LAZINESS. CLDR
 * changed the en-GB abbreviation for September from "Sep" to "Sept", so the literal that
 * `Intl` produces depends on the ICU bundled with the running Node. Pinning it exactly
 * would make this file fail on a Node upgrade for a reason that has nothing to do with the
 * behaviour under test. Everything that IS the behaviour — the UTC calendar day, the
 * 24-hour clock, the en-dash range, the explicit `(UTC)` marker — is pinned exactly.
 */

const START = '2026-09-01T10:00:00.000Z';
const END = '2026-09-01T11:00:00.000Z';
const RAW_TOKEN = 'aaaabbbbccccddddeeeeffff0000111122223333444';
const SITE = 'https://app.balo.expert';
const JOIN_URL = `${SITE}/join/${RAW_TOKEN}`;

type InvitedProps = Parameters<typeof MeetingGuestInvitedEmail>[0];
type RemovedProps = Parameters<typeof MeetingGuestRemovedEmail>[0];

/** Strip the React-Email `<!-- -->` interpolation markers so multi-part text reads naturally. */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&').replaceAll('&#x27;', "'");
}

/**
 * The message as a HUMAN reads it: comments, `<style>` blocks and tags removed.
 *
 * ⚠ NEEDED FOR THE MONEY SWEEP SPECIFICALLY. React-Email emits `<!--$-->` / `<!--/$-->`
 * Suspense markers and inline `style` attributes full of `#`-colours and `linear-gradient`,
 * so a raw `expect(html).not.toContain('$')` fails on framework plumbing rather than on
 * copy. Asserting against the rendered TEXT is what makes "no money token" a claim about
 * what the guest actually sees.
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

function invitedProps(over: Record<string, unknown> = {}): InvitedProps {
  return {
    guestName: 'Dana',
    inviterName: 'Priya',
    inviterOrgLabel: 'Northwind Industrial',
    meetingTitle: 'CPQ implementation',
    scheduledStartIso: START,
    scheduledEndIso: END,
    accessScope: 'meeting',
    expiresOn: '13 August 2026',
    joinUrl: JOIN_URL,
    baseUrl: SITE,
    ...over,
  } as InvitedProps;
}

function removedProps(over: Record<string, unknown> = {}): RemovedProps {
  return {
    guestName: 'Dana',
    meetingTitle: 'CPQ implementation',
    scheduledStartIso: START,
    baseUrl: SITE,
    ...over,
  } as RemovedProps;
}

/**
 * Every money / billing token that must never reach a guest.
 *
 * The AC is "billing unaffected — per-minute of expert time, never per-seat", and this is
 * the surface where a stray figure would leak it to an OUTSIDER who is not the payer.
 */
const MONEY_TOKENS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'a dollar sign', pattern: /\$/ },
  { label: 'a currency code', pattern: /\b(AUD|USD|EUR|GBP)\b/ },
  { label: 'a rate', pattern: /\brates?\b/i },
  { label: 'a price', pattern: /\bpric(e|es|ing)\b/i },
  { label: 'per-minute pricing', pattern: /per[\s-]minute/i },
  { label: 'an invoice', pattern: /\binvoic(e|es|ed)\b/i },
  { label: 'credits', pattern: /\bcredits?\b/i },
  { label: 'a balance', pattern: /\bbalance\b/i },
  { label: 'a charge', pattern: /\bcharg(e|es|ed)\b/i },
  { label: 'a cost', pattern: /\bcosts?\b/i },
  { label: 'a payment', pattern: /\bpay(ment|able)?\b/i },
];

// ── formatMeetingWindowUtc ────────────────────────────────────────────────────────────

describe('formatMeetingWindowUtc — deterministic UTC, never the host zone', () => {
  it('renders a start–end window with an explicit (UTC) marker', () => {
    expect(formatMeetingWindowUtc(START, END)).toMatch(/^Tue, 1 Sept? 2026 · 10:00–11:00 \(UTC\)$/);
  });

  it('renders a single instant when no end is supplied (the removal payload has none)', () => {
    // ⚠ Never a degenerate `10:00–10:00`.
    expect(formatMeetingWindowUtc(START)).toMatch(/^Tue, 1 Sept? 2026 · 10:00 \(UTC\)$/);
    expect(formatMeetingWindowUtc(START)).not.toContain('–');
  });

  it('⚠ formats the UTC instant, NOT the local one — a 23:30Z start stays on its UTC day', () => {
    // This is the assertion that fails if the explicit `timeZone: 'UTC'` is ever dropped:
    // on any zone east of UTC the local calendar day is already Wed 2 Sep.
    const out = formatMeetingWindowUtc('2026-09-01T23:30:00.000Z');

    expect(out).toMatch(/^Tue, 1 Sept? 2026 · 23:30 \(UTC\)$/);
    expect(out).not.toContain('Wed');
    expect(out).not.toContain('2 Sep');
  });

  it('uses a 24-hour clock, so there is no am/pm for a reader to mis-parse', () => {
    const out = formatMeetingWindowUtc('2026-09-01T15:05:00.000Z');

    expect(out).toContain('15:05');
    expect(out).not.toMatch(/\b(am|pm)\b/i);
  });

  it('always states the zone explicitly rather than leaving the reader to guess', () => {
    expect(formatMeetingWindowUtc(START, END)).toContain('(UTC)');
    expect(formatMeetingWindowUtc(START)).toContain('(UTC)');
  });

  it.each([
    { label: 'an unparseable start', start: 'not-a-date', end: END },
    { label: 'an empty start (the factory fallback)', start: '', end: END },
    { label: 'both halves unparseable', start: 'nope', end: 'nope' },
  ])('degrades to the empty string on $label — never "Invalid Date"', ({ start, end }) => {
    const out = formatMeetingWindowUtc(start, end);

    expect(out).toBe('');
    expect(out).not.toContain('Invalid');
  });

  it('degrades the END alone to a single instant rather than losing the whole line', () => {
    // A recoverable half must not cost the reader the part we DO know.
    expect(formatMeetingWindowUtc(START, 'not-a-date')).toMatch(
      /^Tue, 1 Sept? 2026 · 10:00 \(UTC\)$/
    );
  });

  it('omits the whole window block from the email when it degrades to empty', async () => {
    const html = clean(
      await render(
        MeetingGuestInvitedEmail(
          invitedProps({
            scheduledStartIso: '',
            scheduledEndIso: '',
          })
        )
      )
    );

    // The title still renders; there is simply no "Invalid Date" line under it.
    expect(html).toContain('CPQ implementation');
    expect(html).not.toContain('Invalid');
    expect(html).not.toContain('(UTC)');
  });
});

// ── MeetingGuestInvitedEmail ──────────────────────────────────────────────────────────

describe('MeetingGuestInvitedEmail', () => {
  it('names the inviter as "{person} @ {org}", the meeting, and the UTC window', async () => {
    const html = clean(await render(MeetingGuestInvitedEmail(invitedProps())));

    expect(html).toContain('Priya @ Northwind Industrial');
    expect(html).toContain('CPQ implementation');
    expect(html).toMatch(/Tue, 1 Sept? 2026 · 10:00–11:00 \(UTC\)/);
    expect(html).toContain('works until 13 August 2026');
  });

  it('⚠ renders the join URL EXACTLY ONCE, and never the bare token as copyable text', async () => {
    const html = await render(MeetingGuestInvitedEmail(invitedProps()));

    // The CTA button is the only carrier of the credential.
    expect(html.split(JOIN_URL).length - 1).toBe(1);
    expect(html.split(RAW_TOKEN).length - 1).toBe(1);
    // And the token is never rendered as TEXT for the reader to copy — the `proposal-shared`
    // rule. It exists solely inside an `href`.
    expect(textOf(html)).not.toContain(RAW_TOKEN);
  });

  it('⚠ no other href is built by concatenating onto the join URL', async () => {
    const html = await render(MeetingGuestInvitedEmail(invitedProps()));
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href ?? '');

    // The legal footer must be an ORDINARY site link, not `…/join/{token}/legal/privacy` —
    // which would be both a dead link and a second copy of the secret.
    expect(hrefs.filter((href) => href.includes(RAW_TOKEN))).toEqual([JOIN_URL]);
    expect(hrefs).toContain(`${SITE}/legal/privacy`);
    expect(hrefs).toContain(`${SITE}/legal/terms`);
    for (const href of hrefs) {
      expect(href).not.toMatch(/\/join\/[^/]+\//);
    }
  });

  it.each(MONEY_TOKENS)(
    '⚠ the rendered text carries no $label — "billing unaffected, never per-seat"',
    async ({ pattern }) => {
      expect(textOf(await render(MeetingGuestInvitedEmail(invitedProps())))).not.toMatch(pattern);
    }
  );

  it('uses no gendered pronouns, per the copy rule', async () => {
    const text = textOf(await render(MeetingGuestInvitedEmail(invitedProps())));
    expect(text).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
  });

  it('renders no email address other than Balo support (counterparty concealment)', async () => {
    const html = await render(MeetingGuestInvitedEmail(invitedProps()));
    const addresses = [...html.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(([match]) => match);

    // The inviter's address, the guest's own address and any other guest's must never be
    // rendered — the template is not even given one, and this pins that it stays that way.
    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
  });

  /**
   * ⚠⚠ THE INDEPENDENT-EXPERT CASE. `resolveInviterAttribution` returns
   * `inviterOrgLabel === inviterName` for a freelancer ON PURPOSE ("the person IS the
   * party"), and CLAUDE.md states the rule directly: "independent experts keep their own
   * name". A bare `${name} @ ${org}` therefore rendered "Dana Okoro @ Dana Okoro" in the
   * inbox PREVIEW, the hero SUBTEXT and the opening BODY line — three places at once.
   *
   * The existing coverage missed it by only ever testing the agency case (distinct labels)
   * and the fully-empty payload; the org-label-EQUALS-person case had no test at all.
   */
  describe('inviter attribution never repeats the person as their own org', () => {
    const FREELANCER = 'Dana Okoro';

    it.each([
      { label: 'exactly equal', orgLabel: FREELANCER },
      { label: 'differing only in case and padding', orgLabel: '  dana okoro ' },
    ])('drops the "@ org" clause when the org label is $label', async ({ orgLabel }) => {
      const html = clean(
        await render(
          MeetingGuestInvitedEmail(
            invitedProps({ inviterName: FREELANCER, inviterOrgLabel: orgLabel })
          )
        )
      );

      expect(html).not.toContain(`${FREELANCER} @`);
      expect(html).toContain(`${FREELANCER} invited you`);
    });

    it('KEEPS the clause for a genuine agency — the guard is not over-broad', async () => {
      const html = clean(
        await render(
          MeetingGuestInvitedEmail(
            invitedProps({ inviterName: 'Priya Nair', inviterOrgLabel: 'CloudPeak' })
          )
        )
      );

      expect(html).toContain('Priya Nair @ CloudPeak');
    });
  });

  describe('the access-scope disclosure — the whole mitigation for a retrospective grant', () => {
    it('⚠ `engagement` states the RETROSPECTIVE reach in plain language', async () => {
      const html = clean(
        await render(MeetingGuestInvitedEmail(invitedProps({ accessScope: 'engagement' })))
      );

      expect(html).toContain('including ones held before you were invited');
      expect(html).toContain('every call in this piece of work');
    });

    it('⚠ `meeting` does NOT — it says the opposite, and names the org it is scoped away from', async () => {
      const html = clean(
        await render(MeetingGuestInvitedEmail(invitedProps({ accessScope: 'meeting' })))
      );

      expect(html).not.toContain('including ones held before');
      expect(html).not.toContain('every call in this piece of work');
      expect(html).toContain('this call and its recap');
      expect(html).toContain('Nothing else from Northwind Industrial is shared with you');
    });
  });

  describe('the greeting never leaks an address', () => {
    it.each([
      { label: 'no name at all', patch: { guestName: undefined } },
      { label: 'an empty name', patch: { guestName: '' } },
      { label: 'a whitespace-only name', patch: { guestName: '   ' } },
    ])('greets "Hi there," on $label', async ({ patch }) => {
      const html = clean(await render(MeetingGuestInvitedEmail(invitedProps(patch))));

      expect(html).toContain('Hi there,');
      // ⚠ NEVER the email local part — the same leak `projectGuestForViewer` refuses.
      expect(html).not.toMatch(/Hi [^\s@]+@/);
      expect(html).not.toContain('dana@');
    });

    it('greets by the supplied name when there is one, trimmed', async () => {
      const html = clean(
        await render(MeetingGuestInvitedEmail(invitedProps({ guestName: ' Dana ' })))
      );
      expect(html).toContain('Hi Dana,');
    });
  });
});

// ── MeetingGuestRemovedEmail ──────────────────────────────────────────────────────────

describe('MeetingGuestRemovedEmail', () => {
  it('states the withdrawal, names the meeting and its single UTC instant', async () => {
    const html = clean(await render(MeetingGuestRemovedEmail(removedProps())));

    expect(html).toContain('CPQ implementation');
    expect(html).toMatch(/Tue, 1 Sept? 2026 · 10:00 \(UTC\)/);
    expect(html).toContain('has been withdrawn');
  });

  it.each(MONEY_TOKENS)('⚠ the rendered text carries no $label either', async ({ pattern }) => {
    expect(textOf(await render(MeetingGuestRemovedEmail(removedProps())))).not.toMatch(pattern);
  });

  it('is blameless — it neither names a remover nor implies wrongdoing', async () => {
    const html = clean(await render(MeetingGuestRemovedEmail(removedProps())));

    expect(html).not.toMatch(/violat|breach|misuse|unauthoris|unauthoriz|removed you because/i);
    expect(html).toContain('can send a fresh invitation');
  });

  it('⚠ carries NO join link — their credential is dead, so a CTA would be a dead end', async () => {
    const html = await render(MeetingGuestRemovedEmail(removedProps()));

    expect(html).not.toContain('/join/');
    // The only links are the legal footer and the support mailto.
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href ?? '');
    expect(hrefs.sort((a, b) => a.localeCompare(b))).toEqual([
      `${SITE}/legal/privacy`,
      `${SITE}/legal/terms`,
      'mailto:support@getbalo.com',
    ]);
  });

  it('greets "Hi there," for a nameless guest and never by an address', async () => {
    const html = clean(
      await render(MeetingGuestRemovedEmail(removedProps({ guestName: undefined })))
    );

    expect(html).toContain('Hi there,');
    expect(html).not.toMatch(/Hi [^\s@]+@/);
  });

  it('renders no email address other than Balo support', async () => {
    const html = await render(MeetingGuestRemovedEmail(removedProps()));
    const addresses = [...html.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(([match]) => match);

    expect([...new Set(addresses)]).toEqual(['support@getbalo.com']);
  });

  it('uses no gendered pronouns', async () => {
    const text = textOf(await render(MeetingGuestRemovedEmail(removedProps())));
    expect(text).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
  });
});

// ── the `getEmailTemplate` factories ──────────────────────────────────────────────────

describe('getEmailTemplate — meeting-guest-invited', () => {
  it('builds the join URL from the RAW token and a sanitized inviter-named subject', async () => {
    const out = getEmailTemplate('meeting-guest-invited', {
      guestName: 'Dana',
      inviterName: 'Priya',
      inviterOrgLabel: 'Northwind Industrial',
      meetingTitle: 'CPQ implementation',
      scheduledStartIso: START,
      scheduledEndIso: END,
      accessScope: 'engagement',
      expiresOn: '13 August 2026',
      joinToken: RAW_TOKEN,
    });

    expect(out.subject).toBe('Priya invited you to a video call');
    const html = await render(out.component);
    expect(html).toContain(`/join/${RAW_TOKEN}`);
    // ⚠ STILL EXACTLY ONE copy of the credential once the factory has built the URL — the
    // regression this pins is a footer link concatenated onto the join URL.
    expect(html.split(RAW_TOKEN).length - 1).toBe(1);
  });

  it('⚠ never puts the raw token in the SUBJECT line', async () => {
    const out = getEmailTemplate('meeting-guest-invited', {
      inviterName: 'Priya',
      joinToken: RAW_TOKEN,
    });

    expect(out.subject).not.toContain(RAW_TOKEN);
    await expect(render(out.component)).resolves.toContain(RAW_TOKEN);
  });

  /**
   * ⚠⚠ THE DEGRADE DIRECTION, AND IT IS THE OPPOSITE OF WHAT THIS TEST ONCE ASSERTED.
   *
   * A malformed `accessScope` must never UNDER-state what a guest can read. The email is a
   * CONSENT DISCLOSURE, not a permission — it grants nothing, and the real grant lives on
   * `meeting_guests.access_scope`, from which BAL-388 will enforce it. So:
   *   · narrow-when-actually-wide HIDES a RETROSPECTIVE grant from the person it is about,
   *     unrecoverably (they have no account in which to discover it later). That is the
   *     precise failure the disclosure exists to prevent.
   *   · wide-when-actually-narrow merely over-promises history. Nothing is exposed.
   * Over-disclose, never under-disclose.
   */
  it.each(['ENGAGEMENT', 'whole_case', '', undefined, 42])(
    '⚠ degrades an unrecognised accessScope (%p) to the WIDER `engagement` disclosure',
    async (accessScope) => {
      const out = getEmailTemplate('meeting-guest-invited', { accessScope, joinToken: RAW_TOKEN });
      const html = clean(await render(out.component));

      expect(html).toContain('including ones held before you were invited');
      expect(html).toContain('every call in this piece of work');
    }
  );

  it('honours a literal `meeting` scope — the degrade is for MALFORMED input only', async () => {
    const out = getEmailTemplate('meeting-guest-invited', {
      accessScope: 'meeting',
      joinToken: RAW_TOKEN,
    });
    const html = clean(await render(out.component));

    expect(html).not.toContain('including ones held before');
    expect(html).toContain('this call and its recap');
  });

  it('strips control characters from the inviter name in the subject (header injection)', () => {
    const out = getEmailTemplate('meeting-guest-invited', {
      inviterName: 'Priya\r\nBcc: evil@example.com',
      joinToken: RAW_TOKEN,
    });

    expect(out.subject).not.toContain('\n');
    expect(out.subject).not.toContain('\r');
  });

  it('renders with an entirely empty payload rather than throwing', async () => {
    const out = getEmailTemplate('meeting-guest-invited', {});
    const html = clean(await render(out.component));

    expect(html).toContain('Hi there,');
    // ⚠ ENGAGEMENT-TYPE-AGNOSTIC. The fallback must not say "consultation": the service
    // resolves 'a project kickoff' / 'a discovery call' / 'an intro call' just as readily,
    // and the chrome contradicting the value it introduces is the bug this pins.
    expect(html).toContain('a call');
    expect(html).not.toContain('consultation');
    expect(out.subject).toContain('invited you to a video call');
  });

  /**
   * ⚠ `expiresOn` DEFAULTS TO `''` HERE, and interpolating it unconditionally rendered
   * "This link is just for you and works until . If…" — a sentence with a visible hole,
   * in the most-forwarded message on the platform.
   */
  it('omits the expiry clause entirely rather than rendering "works until ."', async () => {
    const out = getEmailTemplate('meeting-guest-invited', { joinToken: RAW_TOKEN });
    const html = clean(await render(out.component));

    expect(html).toContain('This link is just for you.');
    expect(html).not.toContain('works until');
    expect(html).not.toContain('until .');
  });

  /**
   * ⚠ NO `'their team'` PLACEHOLDER. It rendered "Dana Okoro @ their team", which reads as
   * an unsubstituted template variable — worse than the bare name it stood in for.
   */
  it('drops the "@ org" clause when no org label is supplied', async () => {
    const out = getEmailTemplate('meeting-guest-invited', {
      inviterName: 'Dana Okoro',
      joinToken: RAW_TOKEN,
    });
    const html = clean(await render(out.component));

    expect(html).toContain('Dana Okoro invited you');
    expect(html).not.toContain('their team');
    expect(html).not.toContain('Dana Okoro @');
  });
});

describe('getEmailTemplate — meeting-guest-removed', () => {
  it('uses a fixed subject that names no person and carries no CTA link', async () => {
    const out = getEmailTemplate('meeting-guest-removed', {
      guestName: 'Dana',
      meetingTitle: 'CPQ implementation',
      scheduledStartIso: START,
    });

    expect(out.subject).toBe('Your call invitation has been withdrawn');
    const html = await render(out.component);
    expect(html).not.toContain('/join/');
  });

  it('renders with an entirely empty payload rather than throwing', async () => {
    const out = getEmailTemplate('meeting-guest-removed', {});
    const html = clean(await render(out.component));

    expect(html).toContain('Hi there,');
    expect(html).toContain('a call');
    expect(html).not.toContain('consultation');
  });
});
