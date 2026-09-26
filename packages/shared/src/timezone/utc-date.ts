/**
 * utc-date — the SINGLE definition of the two UTC display-date formatters.
 *
 * ⚠⚠ LIVES HERE, NOT IN `apps/web`, so the api's case-inactivity sweep can format
 * `closedDate` identically to web's client-close publisher without either app importing the
 * other. `apps/web/src/lib/format/utc-date.ts` is a re-export of this module — its three
 * existing importers are untouched. Originally extracted (BAL-388) from three re-inlined
 * copies of `formatLongUtc`, two of which fed a notification payload, where a drifted format
 * is a drifted email.
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
