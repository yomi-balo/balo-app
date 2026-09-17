/**
 * RFC 5545 §3.3.11 TEXT escaping, plus an absolute ban on raw line breaks.
 *
 * ⚠ THE SINGLE DEFINITION OF RFC 5545 TEXT ESCAPING IN THE REPO (moved here verbatim from
 * `apps/web/src/components/booking/ics.ts` by BAL-475 §6). The browser `.ics` download calls
 * this function AT RUNTIME. The server-side Balo-organised invite
 * (`apps/api/src/services/calendar-invites/build-calendar-invite-ics.ts`) delegates its own
 * escaping to `ical-generator` (whose internal `escape()` is equivalent) and uses THIS
 * function only as the conformance ORACLE in its tests — never at runtime, because escaping
 * text before handing it to the library would double-escape it (`Northwind, Inc.` would render
 * `Northwind\, Inc.` in every client).
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
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}
