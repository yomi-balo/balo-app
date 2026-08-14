/**
 * BAL-436 — the People panel's POLL CADENCE, as plain constants.
 *
 * ⚠⚠ THEY LIVE HERE, IN A PLAIN MODULE, AND **NOT** IN A `'use server'` FILE. A Server Action
 * module may export ONLY async functions: `export const GUESTS_POLL_INTERVAL_MS = 10_000`
 * inside one fails `next build` with "A 'use server' file can only export async functions" —
 * while `tsc --noEmit`, eslint and vitest ALL pass (memory
 * `reference_use_server_no_value_exports`). `lib/meetings/lobby.ts` exists for the identical
 * reason; this module is its sibling, not a second copy of it, because the two cadences are
 * genuinely different questions (a guest asking "am I in yet?" vs a host watching a queue).
 *
 * ⚠ PURE, AND NO `server-only`. The panel is a `'use client'` component and imports these
 * directly; a `server-only` guard here would break it.
 *
 * ── ⚠⚠ THE CAUTIONARY PRECEDENT, STATED SO NOBODY LOWERS THESE CASUALLY ─────────────────
 *
 * The lobby shipped at a flat 5s poll against a 600/hour per-IP window — roughly 264
 * requests/hour per waiting guest — and three concurrent guests exhausted it between them.
 * `GET /meetings/:id/guests` has NO rate limit today and does three cheap indexed reads, so
 * the bound here is politeness rather than a wall; that is exactly why it has to be a
 * deliberate number instead of a default.
 */

/**
 * The FAST tier: a knock has to feel live to a host who is watching the queue.
 *
 * ⚠ IT IS BOUNDED BY THE PANEL BEING OPEN. Polling pauses entirely when the panel is closed
 * and when the document is hidden, so this cadence only ever runs while somebody is actually
 * looking at the waiting list. A 60-minute call with the panel pinned open costs ~360
 * requests for one host, which is acceptable for three indexed reads.
 */
export const GUESTS_POLL_INTERVAL_MS = 10_000;

/**
 * The IDLE tier, after {@link GUESTS_POLL_BACKOFF_AFTER_MS} with nothing waiting.
 *
 * ⚠ THE TRIGGER IS "NO `pending` ROWS", NOT MERELY ELAPSED TIME. A host staring at a queue
 * with somebody in it must never be slowed down — the whole point of the fast tier is the
 * decision they are about to make. The back-off exists for the far more common case: a panel
 * left open on a call nobody is knocking into.
 */
export const GUESTS_POLL_BACKOFF_INTERVAL_MS = 30_000;

/** How long an idle, knock-free panel stays on the fast tier. Five minutes. */
export const GUESTS_POLL_BACKOFF_AFTER_MS = 300_000;

/**
 * How many CONSECUTIVE retryable failures the poll tolerates before it stops and shows its
 * error state with a Retry button.
 *
 * ⚠ A COUNTER, NOT A ONE-STRIKE RULE, FOR THE REASON `LOBBY_MAX_CONSECUTIVE_POLL_FAILURES`
 * RECORDS: treating every blip as terminal means the schedule never survives a dropped
 * packet, and the panel would show "we couldn't load the list" on a call that is perfectly
 * fine. Bounded rather than infinite so a genuinely dead endpoint does not leave a tab
 * polling for the length of a call. Eight failures spans ~4 minutes at the idle cadence.
 *
 * ⚠ MIRRORS THE LOBBY'S NUMBER DELIBERATELY. Two surfaces, one tolerance — a host and a guest
 * on the same patchy connection should give up at the same point, not at two arbitrary ones.
 */
export const GUESTS_MAX_CONSECUTIVE_POLL_FAILURES = 8;

/**
 * BAL-436 — how long after a host ADMITS somebody before the "Re-send link" affordance
 * appears on their still-absent row.
 *
 * ⚠ A PRODUCT NUMBER, NOT A SAFETY PROPERTY — the same status as `MAX_MEETING_PARTICIPANTS`
 * and `MAX_LOBBY_QUEUE`, and a natural early `platform_config` entry. ⚠⚠ DO NOT import
 * `platform_config`: BAL-398's PR is NOT merged and `main` has no config table, so this is a
 * typed const today.
 *
 * One minute: long enough that a normal page load, a device-permission prompt and a slow
 * first paint never trip it, short enough that a genuinely stuck guest is rescued inside the
 * first slice of a call rather than after it.
 *
 * ⚠ IT IS MEASURED AGAINST THE **SERVER'S** `admissionDecidedAt`, never a client clock. The
 * panel is opened and closed at will and the tab can reload mid-call, so a client-side timer
 * restarts and the affordance would appear late, early, or twice.
 */
export const ADMITTED_NOT_ARRIVED_GRACE_MS = 60_000;
