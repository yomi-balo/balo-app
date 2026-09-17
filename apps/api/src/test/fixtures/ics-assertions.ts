/**
 * BAL-475 (fix round 1, F12 — R11 single-source) — the ONE `unfold` + "which properties carry
 * an address" implementation, shared by the builder's own unit test
 * (`services/calendar-invites/build-calendar-invite-ics.test.ts`), the counterparty-address
 * invariant's Layer 2b (`invariants/no-counterparty-address-on-calendar-writes.test.ts`), and
 * the delivery module's end-to-end test (F8(a),
 * `notifications/channels/calendar-invite-delivery.test.ts`). Test-only: lives outside both
 * scanned roots (`services/consultation-events/`, `services/calendar-invites/`) and is never
 * imported by application code.
 */

/** Unfold RFC 5545 folded lines (continuation lines begin with a single space) back to one
 *  logical line per property, then split into an array. */
export function unfoldIcs(ics: string): string[] {
  return ics
    .replaceAll('\r\n ', '')
    .split('\r\n')
    .filter((line) => line.length > 0);
}

/** The property NAME (substring before the first `;` or `:`) of every unfolded line that
 *  contains an `@` — i.e. every content line that names an address. */
export function icsAddressPropertyNames(lines: readonly string[]): string[] {
  const addressLines = lines.filter((line) => line.includes('@'));
  return addressLines.map((line) => {
    const semicolon = line.indexOf(';');
    const colon = line.indexOf(':');
    const candidates = [semicolon, colon].filter((index) => index !== -1);
    const end = candidates.length > 0 ? Math.min(...candidates) : line.length;
    return line.slice(0, end);
  });
}
