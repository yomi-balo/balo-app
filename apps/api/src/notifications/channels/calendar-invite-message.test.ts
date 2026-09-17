import { describe, expect, it } from 'vitest';
import MailComposer from 'nodemailer/lib/mail-composer';
import {
  buildCalendarInviteMailOptions,
  CALENDAR_INVITE_FILENAME,
  type CalendarInviteMailInput,
} from './calendar-invite-message.js';

const FIXTURE: CalendarInviteMailInput = {
  organizerAddress: 'no-reply@balo.test',
  recipientAddress: 'recipient@example.test',
  recipientName: 'Dana',
  subject: 'Calendar invite: Consultation with Northwind Industrial',
  html: '<p>Hello</p>',
  text: 'Hello',
  ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n',
};

/** Unfold RFC 5322 folded header lines (continuation lines begin with whitespace). */
function unfoldHeaders(raw: string): string {
  return raw.replaceAll('\r\n ', ' ').replaceAll('\r\n\t', ' ');
}

async function buildRawMessage(): Promise<string> {
  const options = buildCalendarInviteMailOptions(FIXTURE);
  const composer = new MailComposer(options);
  const buffer = await composer.compile().build();
  return buffer.toString('utf8');
}

/** RFC 2045 quoted-printable decoder — soft line breaks (`=\r\n`) then `=XX` hex octets. */
function decodeQuotedPrintable(input: string): string {
  return input
    .replaceAll('=\r\n', '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * F31 (fix round 1) — find the ONE MIME part, AT ANY NESTING DEPTH, whose `Content-Type`
 * starts with `contentTypePrefix`, and decode its body per its OWN `Content-Transfer-Encoding`
 * header (base64 / quoted-printable / 7bit-8bit passthrough).
 *
 * ⚠ THE STRUCTURE IS NESTED, AND THAT IS WHY THIS SPLITS ON EVERY BOUNDARY IT FINDS, NOT JUST
 * THE OUTERMOST ONE. `text/calendar` sits inside the `multipart/alternative` sub-part, itself a
 * child of the outer `multipart/mixed` — verified against the real built message. Splitting on
 * only the outer boundary leaves the alternative sub-part as ONE opaque chunk containing its
 * own nested boundary markers, and a substring search for `Content-Type: text/calendar` on
 * that chunk's own (wrapper) headers finds nothing. Collecting every `boundary="..."` value in
 * the message and splitting on each in turn flattens the whole tree regardless of depth.
 */
function decodedMimePartBody(raw: string, contentTypePrefix: string): string {
  const boundaries = [...raw.matchAll(/boundary="([^"]+)"/g)].map((match) => match[1]);
  if (boundaries.length === 0) {
    throw new Error('no MIME boundaries found in the built message');
  }

  let chunks = [raw];
  for (const boundary of boundaries) {
    chunks = chunks.flatMap((chunk) => chunk.split(`--${boundary}`));
  }

  for (const chunk of chunks) {
    const split = chunk.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const headers = chunk.slice(0, split);
    if (!headers.includes(`Content-Type: ${contentTypePrefix}`)) continue;

    // Exactly ONE trailing CRLF is the MIME delimiter's own separator (the line break that
    // always precedes a boundary marker) — strip only that, never a full `.trim()`, or the
    // ICS's own genuine trailing CRLF (part of the RFC 5545 content itself) is lost too.
    const body = chunk.slice(split + 4).replace(/\r\n$/, '');
    const cteMatch = /Content-Transfer-Encoding:\s*(\S+)/i.exec(headers);
    const encoding = (cteMatch?.[1] ?? '7bit').toLowerCase();
    if (encoding === 'base64') {
      return Buffer.from(body.replaceAll(/\r?\n/g, ''), 'base64').toString('utf8');
    }
    if (encoding === 'quoted-printable') {
      return decodeQuotedPrintable(body);
    }
    return body;
  }
  throw new Error(`no MIME part found with Content-Type starting "${contentTypePrefix}"`);
}

describe('buildCalendarInviteMailOptions', () => {
  it('has no attachments key — ADR-1044 Ruling 4 guardrail 2', () => {
    const options = buildCalendarInviteMailOptions(FIXTURE);
    expect(options).not.toHaveProperty('attachments');
  });

  it('sets the icalEvent method to REQUEST with the given filename and content', () => {
    const options = buildCalendarInviteMailOptions(FIXTURE);
    expect(options.icalEvent).toEqual({
      method: 'REQUEST',
      filename: CALENDAR_INVITE_FILENAME,
      content: FIXTURE.ics,
    });
  });

  it('sets from = Balo <organizerAddress> and to = recipientName <recipientAddress>', () => {
    const options = buildCalendarInviteMailOptions(FIXTURE);
    expect(options.from).toEqual({ name: 'Balo', address: 'no-reply@balo.test' });
    expect(options.to).toEqual({ name: 'Dana', address: 'recipient@example.test' });
  });
});

describe('the built MIME message (CI-assertable, never a live send)', () => {
  it('produces exactly the expected Content-Type sequence, one Content-Disposition: attachment, and no other attachments', async () => {
    const raw = unfoldHeaders(await buildRawMessage());
    const contentTypeLines = raw
      .split('\r\n')
      .filter((line) => line.startsWith('Content-Type:'))
      .map((line) => line.replace(/;\s*boundary="[^"]*"/, ''));

    expect(contentTypeLines).toEqual([
      'Content-Type: multipart/mixed',
      'Content-Type: multipart/alternative',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Type: text/html; charset=utf-8',
      'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
      `Content-Type: application/ics; name=${CALENDAR_INVITE_FILENAME}`,
    ]);

    const dispositionLines = raw
      .split('\r\n')
      .filter((line) => line.startsWith('Content-Disposition:'));
    expect(dispositionLines).toHaveLength(1);
    expect(dispositionLines[0]).toContain(`filename=${CALENDAR_INVITE_FILENAME}`);
    expect(dispositionLines[0]).toContain('attachment');
  });

  /**
   * F31 (fix round 1, tech AC map) — ACTUALLY DECODES the part per its own
   * Content-Transfer-Encoding header and asserts EQUALITY with the input ICS, rather than a
   * `BEGIN:VCALENDAR` substring search. A substring match survives 7bit/quoted-printable
   * (ASCII passes through untouched) but says nothing about base64 — the exact title this test
   * already claimed to prove.
   */
  it('the text/calendar part decodes back to EXACTLY the input ICS', async () => {
    const raw = await buildRawMessage();
    const decoded = decodedMimePartBody(raw, 'text/calendar');
    expect(decoded).toBe(FIXTURE.ics);
  });

  it('the application/ics attachment part ALSO decodes back to EXACTLY the input ICS', async () => {
    const raw = await buildRawMessage();
    const decoded = decodedMimePartBody(raw, 'application/ics');
    expect(decoded).toBe(FIXTURE.ics);
  });
});
