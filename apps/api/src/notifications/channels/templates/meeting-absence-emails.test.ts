import { describe, expect, it } from 'vitest';
import { render } from '@react-email/render';
import {
  MeetingClientAbsentEmail,
  MeetingExpertAbsentAdminEmail,
} from './meeting-absence-emails.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';
const MEETING_ID = 'mtg-1';

/** Strip the React-Email `<!-- -->` interpolation markers so multi-part text reads naturally. */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&').replaceAll('&#x27;', "'");
}

/**
 * ⚠⚠ THE COPY RULE BOTH TEMPLATES ARE WRITTEN TO, ASSERTED RATHER THAN ONLY DOCUMENTED.
 *
 *  · GENDER-NEUTRAL — never a pronoun for an expert or a client;
 *  · NO MONEY, EVER — nothing is charged until BOTH sides are present, so a charge claim would
 *    be FALSE, and a "you will be charged" line would be a threat aimed at somebody whose only
 *    offence is being a few minutes late. This ticket produces the MEASUREMENT; BAL-412 settles.
 */
/**
 * ⚠ BOTH LISTS ARE MATCHED AS WHOLE WORDS, AND THE MONEY ONE ESPECIALLY HAD TO BE FIXED. As raw
 * substrings, `'fee'` fires on "feedback" and `'aud'` fires on "audio" — two words that belong
 * in a call-related email — so the guard would have blocked innocent copy while its author
 * assumed it was catching money claims. `assertRegister` normalises punctuation to spaces and
 * pads both ends, so `' charged '` matches "…will be charged." and `' aud '` cannot match
 * "audio". `$` stays a raw scan: it is a symbol, not a word, and React-Email's `<!--$-->`
 * markers are already gone by the time `visibleText` is done.
 */
const GENDERED = ['he', 'she', 'his', 'her', 'him', 'hers'];
const MONEY = [
  'charge',
  'charged',
  'charges',
  'charging',
  'bill',
  'billed',
  'billing',
  'invoice',
  'invoiced',
  'aud',
  'usd',
  'fee',
  'fees',
];

/**
 * The VISIBLE prose of a rendered email — tags, comments and inline `<style>` removed by a
 * single LINEAR SCAN.
 *
 * ⚠ NOT A REGEX, DELIBERATELY. `/<[^>]*>/g` is a SonarCloud S5852 super-linear-backtracking
 * hotspot (`[^>]` still matches `<`, so overlapping start positions re-scan the same region);
 * `@balo/shared/notifications`'s `stripHtmlTags` records the same reasoning and takes the same
 * approach. ⚠ AND STRIPPING IS NOT COSMETIC HERE: React-Email's shell emits `<!--$-->` markers,
 * so a raw-HTML check for `$` fails on every template ever written.
 */
function visibleText(html: string): string {
  let out = '';
  let depth = 0;
  for (const character of html) {
    if (character === '<') {
      depth += 1;
    } else if (character === '>' && depth > 0) {
      depth -= 1;
      out += ' ';
    } else if (depth === 0) {
      out += character;
    }
  }
  return out;
}

/**
 * Everything that is not a letter, a digit or `$` becomes a space, then the whole string is
 * padded — so every word sits between two spaces and `' word '` is a true whole-word match
 * regardless of the punctuation around it.
 *
 * ⚠ THE REGEX IS A SINGLE CHARACTER CLASS WITH ONE QUANTIFIER — linear, no nesting, no
 * alternation, so no S5852 backtracking hotspot.
 */
function words(text: string): string {
  return ` ${visibleText(text)
    .toLowerCase()
    .replaceAll(/[^a-z0-9$]+/g, ' ')} `;
}

function assertRegister(text: string): void {
  const normalised = words(text);
  for (const word of [...GENDERED, ...MONEY]) {
    expect(normalised).not.toContain(` ${word} `);
  }
  // `$` is a symbol, not a word — scanned raw, on the tag-stripped text.
  expect(normalised).not.toContain('$');
}

/**
 * ⚠ THE GUARD IS ITSELF GUARDED. A copy assertion that fires on the wrong words is worse than
 * none: it blocks legitimate prose and trains its next reader to weaken it.
 */
describe('assertRegister — the copy guard matches WHOLE WORDS', () => {
  it('⚠ does not fire on words that merely CONTAIN a banned one', () => {
    expect(() =>
      assertRegister('<p>Leave feedback about the audio, and check here for the theme.</p>')
    ).not.toThrow();
  });

  it('still catches a real money claim and a real pronoun, whatever the punctuation', () => {
    expect(() => assertRegister('<p>You will be charged.</p>')).toThrow();
    expect(() => assertRegister('<p>Ask him, not us.</p>')).toThrow();
    expect(() => assertRegister('<p>Total: 40 AUD</p>')).toThrow();
    expect(() => assertRegister('<p>That is $40.</p>')).toThrow();
  });
});

describe('MeetingExpertAbsentAdminEmail (BAL-134 — the ops salvage alert)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    meetingId: MEETING_ID,
    minutesPastStart: 5,
    contextLabel: 'Case consultation',
    scheduledStartIso: '2026-08-14T10:00:00.000Z',
    baseUrl: BASE,
    ...over,
  });

  it('states the threshold that was crossed and deep-links the consultation', async () => {
    const html = clean(await render(MeetingExpertAbsentAdminEmail(props())));

    expect(html).toContain('An expert has not joined.');
    expect(html).toContain('5 minutes after the scheduled start');
    expect(html).toContain(`${BASE}/meetings/${MEETING_ID}`);
  });

  it('says why it needs a human — the operational commitment is the point', async () => {
    const html = clean(await render(MeetingExpertAbsentAdminEmail(props())));

    expect(html).toContain('Balo has committed to contacting the expert');
  });

  it('carries the triage line: context, schedule and meeting id', async () => {
    const html = clean(await render(MeetingExpertAbsentAdminEmail(props())));

    expect(html).toContain('Case consultation');
    expect(html).toContain(MEETING_ID);
  });

  /**
   * ⚠ IT NAMES NOBODY, AND THAT IS DELIBERATE RATHER THAN THIN. A name frozen into a scheduled
   * row would be stale by fire time and is PII sitting in a Postgres table for the life of the
   * promise (ADR-1047 Decision 4) in exchange for nothing — ops opens the meeting to act.
   */
  it('⚠ names no person', async () => {
    const html = clean(await render(MeetingExpertAbsentAdminEmail(props())));

    assertRegister(html);
  });

  it('is registered under `meeting-expert-absent-admin` with an ops-legible subject', () => {
    const output = getEmailTemplate('meeting-expert-absent-admin', {
      meetingId: MEETING_ID,
      minutesPastStart: 5,
      contextType: 'case',
      scheduledStartIso: '2026-08-14T10:00:00.000Z',
    });

    expect(output.subject).toBe('Expert has not joined a consultation');
  });

  it('humanises a known context label and degrades an unknown one to a neutral noun', () => {
    const known = getEmailTemplate('meeting-expert-absent-admin', {
      meetingId: MEETING_ID,
      contextType: 'project_kickoff',
    });
    const unknown = getEmailTemplate('meeting-expert-absent-admin', {
      meetingId: MEETING_ID,
      contextType: 'something_new',
    });

    expect(known.component.props).toMatchObject({ contextLabel: 'Project kickoff' });
    // ⚠ NEVER A RAW ENUM STRING IN AN EMAIL.
    expect(unknown.component.props).toMatchObject({ contextLabel: 'Consultation' });
  });
});

describe('MeetingClientAbsentEmail (BAL-134 — the client nudge)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Dana',
    waitingPartyName: 'CloudPeak',
    meetingId: MEETING_ID,
    baseUrl: BASE,
    ...over,
  });

  it('greets by first name and links straight into the call', async () => {
    const html = clean(await render(MeetingClientAbsentEmail(props())));

    expect(html).toContain('Hi Dana,');
    expect(html).toContain('Your consultation has started.');
    expect(html).toContain(`${BASE}/meetings/${MEETING_ID}/call`);
  });

  /**
   * ⚠ PROSPECTIVE COPY NAMES THE **PARTY** — the expert's agency, or an independent expert's own
   * name — never an invented individual (CLAUDE.md's attribution rule).
   */
  it('⚠ names the waiting PARTY when one is known', async () => {
    const html = clean(await render(MeetingClientAbsentEmail(props())));

    expect(html).toContain('CloudPeak is in the room and ready when you are.');
  });

  it('⚠ falls back to party-NEUTRAL copy rather than guessing a name', async () => {
    const html = clean(
      await render(MeetingClientAbsentEmail(props({ waitingPartyName: undefined })))
    );

    expect(html).toContain('Your expert is in the room and ready when you are.');
    expect(html).not.toContain('undefined');
  });

  /**
   * ⚠⚠ NO BILLING LINE. Nothing is charged until both sides are present, so a charge claim
   * would be false; a "you will be charged" line would be a threat aimed at somebody a few
   * minutes late. Warm and factual — "no problem at all".
   */
  it('⚠⚠ carries NO money claim and no gendered pronoun', async () => {
    const html = clean(await render(MeetingClientAbsentEmail(props())));

    assertRegister(html);
    expect(html).toContain('no problem at all');
  });

  it('is registered under `meeting-client-absent`, with the party name passed through', () => {
    const output = getEmailTemplate('meeting-client-absent', {
      recipientName: 'Dana',
      waitingPartyName: 'CloudPeak',
      meetingId: MEETING_ID,
    });

    expect(output.subject).toBe('Your consultation has started');
    expect(output.component.props).toMatchObject({
      firstName: 'Dana',
      waitingPartyName: 'CloudPeak',
    });
  });

  /** ⚠ EXPLICITLY `undefined`, so the component renders neutral copy rather than an empty name. */
  it('⚠ passes `undefined` (not a placeholder) when the payload names no party', () => {
    const output = getEmailTemplate('meeting-client-absent', {
      recipientName: 'Dana',
      meetingId: MEETING_ID,
      waitingPartyName: '',
    });

    expect(output.component.props).toMatchObject({ waitingPartyName: undefined });
  });
});

/**
 * ⚠⚠ THE IN-APP ENTRY IS LOAD-BEARING IN A WAY A MISSING EMAIL TEMPLATE IS NOT.
 * `getInAppTemplate` does NOT throw on an unknown name — it silently returns the generic "You
 * have a new notification". So an absent entry degrades to a MEANINGLESS nudge with a green CI,
 * which is why these assert the REAL title and body rather than merely that something rendered.
 */
describe('the `meeting-client-absent` IN-APP template', () => {
  it('renders the real title and body, and links into the call', () => {
    const result = getInAppTemplate('meeting-client-absent', {
      waitingPartyName: 'CloudPeak',
      meetingId: MEETING_ID,
    });

    expect(result.title).toBe('Your consultation has started');
    expect(result.body).toBe('CloudPeak is in the room and ready when you are.');
    expect(result.actionUrl).toBe(`/meetings/${MEETING_ID}/call`);
  });

  it('⚠ falls back to a party-neutral subject rather than guessing', () => {
    const result = getInAppTemplate('meeting-client-absent', { meetingId: MEETING_ID });

    expect(result.body).toBe('Your expert is in the room and ready when you are.');
  });

  it('omits the action url rather than linking to nowhere', () => {
    const result = getInAppTemplate('meeting-client-absent', {});

    expect(result.actionUrl).toBeUndefined();
    expect(result.title).toBe('Your consultation has started');
  });

  it('⚠ carries no money claim', () => {
    const result = getInAppTemplate('meeting-client-absent', { meetingId: MEETING_ID });

    assertRegister(`${result.title} ${result.body}`);
  });
});
