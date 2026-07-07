/**
 * oversight-constants — the client-safe tunables behind the admin engagements
 * oversight list (BAL-335). NO `server-only`, NO `@balo/db` value import, so both
 * the pure derivers (`oversight-row.ts`) and any `"use client"` shell can import
 * them without dragging postgres-js into the browser bundle.
 */

/**
 * Days an `active`/`pending_acceptance` engagement may go without milestone
 * activity before the oversight list flags it "stalled". 14 days is long enough
 * that a healthy delivery cadence never trips it, short enough that a genuinely
 * quiet engagement surfaces within a fortnight. Start at 14, get real signal from
 * the flagged set, then tune; a v2 may push an admin nudge off the same threshold.
 * Named const, never a magic number. (Product decision — tunable; flag to reviewer.)
 */
export const STALLED_AFTER_DAYS = 14;

/** Milliseconds in one day — the unit for every whole-day span in the derivers. */
export const DAY_MS = 1000 * 60 * 60 * 24;
