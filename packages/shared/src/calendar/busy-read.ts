/**
 * The ONE definition of which calendar connections a busy read trusts, shared by the API's
 * vendor busy read (`listBusyBlocks`, which fails closed on them), the connection route and the
 * web live-status derivation. Never re-derive these rules.
 *
 * ⚠ `credentialStatus` is typed `string`, NOT the DB's `CalendarCredentialStatus` union.
 * `@balo/shared` cannot import `@balo/db` (the dependency direction is `@balo/db → @balo/shared`,
 * never the reverse). `packages/db/src/invariants/calendar-reconnect-statuses-are-db-labels.test.ts`
 * pins `BUSY_READABLE_CREDENTIAL_STATUS` to a real DB label.
 */
export const BUSY_READABLE_CREDENTIAL_STATUS = 'ACTIVE';

export interface BusyReadTargetState {
  readonly credentialStatus: string;
  readonly provisioned: boolean;
  readonly calendarIds: readonly string[];
}

/**
 * round-2 fix #5 — a PROVISIONED connection with no conflict-checked calendar is the expert's
 * explicit choice (§9.4) and its data is irrelevant regardless of whether its credential later
 * expires — an expert with one healthy connection and a second they deliberately opted every
 * calendar out of must not go entirely unbookable the moment that second credential expires.
 * An UNPROVISIONED connection is never excluded here even though its `calendarIds` is also
 * `[]` structurally — Balo has never listed its calendars, so we don't know what
 * conflict-checked calendars might be hidden there, and it must still be checked (`isUnreadable`).
 *
 * Exported so GET `/api/calendar/connection` can answer "would breaking THIS connection block
 * bookings?" with the same rule `listBusyBlocks` applies, instead of re-deriving it.
 */
export function isConsideredForBusyRead(
  target: Pick<BusyReadTargetState, 'provisioned' | 'calendarIds'>
): boolean {
  return !target.provisioned || target.calendarIds.length > 0;
}

/**
 * A connection whose read cannot be trusted — not `ACTIVE`, or `ACTIVE` with no sub-calendar
 * rows at all (never provisioned). Distinct from "provisioned but every sub-calendar has
 * `conflict_check = false`", which is a readable connection that simply contributes nothing
 * (the expert's explicit choice, §9.4) — that case is handled by the `calendarIds.length`
 * filter in `isConsideredForBusyRead`, not by this predicate.
 */
export function isUnreadable(
  target: Pick<BusyReadTargetState, 'credentialStatus' | 'provisioned'>
): boolean {
  return target.credentialStatus !== BUSY_READABLE_CREDENTIAL_STATUS || !target.provisioned;
}

/** THE composition `listBusyBlocks` fails closed on: considered AND unreadable. */
export function unreadableBusyReadTargets<T extends BusyReadTargetState>(
  targets: readonly T[]
): T[] {
  return targets.filter(isConsideredForBusyRead).filter(isUnreadable);
}
