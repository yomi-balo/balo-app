const MS_PER_DAY = 86_400_000;

/**
 * BAL-489 (R9) — THE ONE `days_since_meeting` DERIVATION. Extracted VERBATIM from the guest recap
 * page (`app/join/[token]/recap/[meetingId]/page.tsx`, BAL-439 fix-round-1 / S6) so both producers
 * share it: `guest_recap_viewed` (the page) and `guest_converted_to_member`
 * (`lib/guest-conversion/run-guest-conversion.ts`). Both pass the meeting's
 * `started_at ?? scheduled_start` as an ISO string. Do not write a second formula.
 *
 * Whole days between `occurredAtIso` and now, FLOORED, NEVER NEGATIVE — a meeting that has not
 * happened yet reads `0`, and an unparseable timestamp reads `0` rather than `NaN`.
 *
 * PURE apart from `Date.now()`; no imports, safe from any server module.
 */
export function daysSinceMeeting(occurredAtIso: string): number {
  const occurredAtMs = new Date(occurredAtIso).getTime();
  if (Number.isNaN(occurredAtMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - occurredAtMs) / MS_PER_DAY));
}
