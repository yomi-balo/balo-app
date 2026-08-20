/**
 * BAL-134 (D8) — THE FIVE MEETING LIFECYCLE TIMERS, AS TYPED DEFAULTS.
 *
 * ⚠⚠ THERE ARE **FIVE**, NOT FOUR, AND THE TWO FIVE-MINUTE ONES MUST NOT BE UNIFIED. They
 * carry the same default and have DIFFERENT ANCHORS, so collapsing them would be a silent
 * behaviour change the moment either is overridden:
 *
 *   · {@link EXPERT_ABSENT_ALERT_MS} is anchored on `meetings.scheduled_start` — the wall
 *     clock, because the thing being measured is that NOBODY turned up.
 *   · {@link CLIENT_ABSENT_NUDGE_MS} is anchored on the EXPERT-PRESENT CLOCK START,
 *     `max(scheduled_start, expert first join)` — because an expert who joins at 10:05 for a
 *     10:00 call has been waiting five minutes at 10:10, not ten.
 *
 * ⚠⚠ NO `process.env` IN THIS FILE, AND NO I/O. `@balo/shared/meetings` is DELIBERATELY
 * CLIENT-REACHABLE — BAL-403's in-session panel imports `computeMeetingClocks` from this exact
 * subpath precisely to avoid the `@balo/db` client-bundle footgun (memory
 * `reference_balo_db_client_bundle_footgun`). A `process.env` read here would ship into a
 * browser bundle. The env-override reader lives at `apps/api/src/config/meeting-timers.ts`
 * and is the ONLY place these five variables are read.
 *
 * ⚠ AND THE BROWSER NEVER SEES A THRESHOLD AT ALL. The waiting phase is computed SERVER-SIDE
 * (`resolveWaitingPhase`, reached through `GET /meetings/:meetingId/state`) and sent on the
 * wire as a LABEL. That is the acceptance criterion verbatim — "all timing is
 * server-authoritative; the client renders a mirror" — and it structurally eliminates the
 * drift an env override would otherwise create between an overridden server and a
 * default-carrying browser bundle.
 *
 * PRODUCT-TUNABLE. These are product numbers, not physical limits — the same status as
 * `bounds.ts`'s booking envelope, and typed consts for the same reason: `platform_config`
 * (BAL-398 / PR #180) is NOT on main, so there is nothing to host them in yet. When it lands,
 * this is a natural early migration.
 *
 * PURE and dependency-free (the `@balo/shared/engagements` precedent). Every consumer INJECTS
 * these — `lifecycle.ts` reads no clock and no constant of its own.
 */

import { MIN_MEETING_MINUTES } from './bounds';

const MS_PER_MINUTE = 60_000;

/**
 * The expert has not joined by `scheduled_start + this` ⇒ alert Balo ops so a human can chase
 * them. Anchored on `meetings.scheduled_start`.
 *
 * ⚠ AN ALERT, NOT A TERMINATION. The salvage window runs until
 * {@link MISSED_CALL_TERMINATION_MS}, and an expert joining at 10:09 on a 10:10 threshold
 * disarms the missed-call rule permanently (edge case 13).
 *
 * Env override: `MEETING_EXPERT_ABSENT_ALERT_MINUTES`.
 */
export const EXPERT_ABSENT_ALERT_MS = 5 * MS_PER_MINUTE;

/**
 * The expert has STILL not joined by `scheduled_start + this` ⇒ the meeting is a MISSED CALL:
 * terminated, `outcome = 'missed_call'`, nothing owed. Anchored on `scheduled_start`.
 *
 * Env override: `MEETING_MISSED_CALL_MINUTES`.
 */
export const MISSED_CALL_TERMINATION_MS = 10 * MS_PER_MINUTE;

/**
 * The expert is present and no client-side participant has arrived by
 * `max(scheduled_start, expert first join) + this` ⇒ nudge the client company.
 *
 * ⚠ THE ANCHOR IS THE EXPERT-PRESENT CLOCK START, NOT `scheduled_start`. See the module
 * docblock — this is the whole reason it is a separate constant from
 * {@link EXPERT_ABSENT_ALERT_MS} despite sharing its default.
 *
 * Env override: `MEETING_CLIENT_ABSENT_NUDGE_MINUTES`.
 */
export const CLIENT_ABSENT_NUDGE_MS = 5 * MS_PER_MINUTE;

/**
 * The expert has held the room this long with no client-side participant EVER ⇒ the meeting
 * settles as `no_show_client`. Anchored on the expert-present clock start.
 *
 * ⚠ THE FLOOR IS A MONEY NUMBER, AND IT IS DERIVED FROM `bounds.ts`'S `MIN_MEETING_MINUTES`,
 * NOT A SECOND COPY OF `15`. `bounds.ts` carried the instruction "if BAL-412 ever encodes it,
 * THESE TWO MUST NOT DRIFT — import one from the other" (D5). BAL-412 encoded it: this is the
 * settlement floor an expert must have held before a no-show settles in their favour, and it
 * is IMPORTED, not restated, so a single edit to `MIN_MEETING_MINUTES` moves both the booking
 * minimum and this timer together. An expert who leaves at minute 8 never reaches it and
 * settles as an ABANDONED WAIT instead (D2/D9), with NO outcome.
 *
 * Env override: `MEETING_NO_SHOW_FLOOR_MINUTES` (`apps/api/src/config/billing-floor.ts` reads
 * the resolved value back off `resolveMeetingTimers().noShowFloorMs` — ONE override, ONE seam).
 */
export const NO_SHOW_FLOOR_MS = MIN_MEETING_MINUTES * MS_PER_MINUTE;

/**
 * The room has been EMPTY this long ⇒ terminate. Anchored on the instant the room became
 * empty (the latest `meeting_presence.left_at`).
 *
 * ⚠ IT IS SCOPED, ON BOTH OF ITS USES, TO A MEETING SOMEBODY ACTUALLY REACHED — never to
 * "is empty" (ADR-1049 forbids widening it, and the four terminal rules are disjoint by
 * status/presence precisely because of that scoping). Widening it would pre-empt the no-show
 * and missed-call rules on a room nobody ever entered.
 *
 * Env override: `MEETING_IDLE_END_MINUTES`.
 */
export const IDLE_END_EMPTY_MS = 5 * MS_PER_MINUTE;

/**
 * The five timers as ONE injected value.
 *
 * ⚠ EVERY LIFECYCLE FUNCTION TAKES THIS RATHER THAN READING THE CONSTANTS ABOVE. That is what
 * lets `apps/api` hand the ENV-RESOLVED set to the sweep and to the state route, and what lets
 * a test state a scenario in whole minutes without monkey-patching a module.
 */
export interface MeetingTimers {
  /** @see EXPERT_ABSENT_ALERT_MS */
  readonly expertAbsentAlertMs: number;
  /** @see MISSED_CALL_TERMINATION_MS */
  readonly missedCallTerminationMs: number;
  /** @see CLIENT_ABSENT_NUDGE_MS */
  readonly clientAbsentNudgeMs: number;
  /** @see NO_SHOW_FLOOR_MS */
  readonly noShowFloorMs: number;
  /** @see IDLE_END_EMPTY_MS */
  readonly idleEndEmptyMs: number;
}

/** The shipped defaults, as one value. `apps/api` overlays env overrides onto this. */
export const DEFAULT_MEETING_TIMERS: MeetingTimers = {
  expertAbsentAlertMs: EXPERT_ABSENT_ALERT_MS,
  missedCallTerminationMs: MISSED_CALL_TERMINATION_MS,
  clientAbsentNudgeMs: CLIENT_ABSENT_NUDGE_MS,
  noShowFloorMs: NO_SHOW_FLOOR_MS,
  idleEndEmptyMs: IDLE_END_EMPTY_MS,
};

/**
 * ⚠ THE INVARIANT THE FIVE NUMBERS MUST SATISFY, STATED AS CODE RATHER THAN AS PROSE.
 *
 * An ALERT must fire strictly BEFORE the termination it is trying to prevent, on both
 * progressions — otherwise Balo would be told "nobody turned up" only after having already
 * closed the meeting, and the salvage window this feature exists to create would be zero
 * seconds wide. `apps/api`'s env reader calls this and refuses (logs + falls back) on a
 * violating override, so a typo in a Railway variable cannot silently disarm the alerts.
 */
export function meetingTimersAreCoherent(timers: MeetingTimers): boolean {
  return (
    timers.expertAbsentAlertMs > 0 &&
    timers.missedCallTerminationMs > timers.expertAbsentAlertMs &&
    timers.clientAbsentNudgeMs > 0 &&
    timers.noShowFloorMs > timers.clientAbsentNudgeMs &&
    timers.idleEndEmptyMs > 0
  );
}
