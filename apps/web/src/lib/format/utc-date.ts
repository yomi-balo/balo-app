/**
 * utc-date — the SINGLE definition of the two UTC display-date formatters.
 *
 * ⚠⚠ EXTRACTED, NOT INVENTED (BAL-388). `formatLongUtc` had been re-inlined THREE times:
 * `engagement-lifecycle-shared.ts`, `_lib/load-recap.ts` and `_actions/resolve-case.ts` — and
 * two of those spellings feed a NOTIFICATION PAYLOAD, where a drifted format is a drifted
 * email. Three identical spellings of a date formatter is exactly the drift the
 * single-source-of-truth rule exists to stop, and the shape SonarCloud new-code duplication
 * gate catches. `engagement-lifecycle-shared.ts` now RE-EXPORTS these, so its three existing
 * importers are untouched.
 *
 * Deterministic under `TZ=UTC` and identical on server and client (the timeZone option is
 * explicit), so either may format a stored instant without a hydration mismatch.
 */

/** "4 Jul" — day + short month, UTC. */
export function formatShortUtc(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/** "9 Jul 2026" — day + short month + year, UTC. */
export function formatLongUtc(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
