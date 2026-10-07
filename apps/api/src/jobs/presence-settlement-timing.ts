/**
 * The two presence-settlement timings that must stay ordered against each other, in a leaf module
 * so the meter sweep and the admin-alert finders can both read them without importing one another.
 */

/**
 * BAL-412 (plan §4.3) — how far behind `now` a meeting's `ended_at` must be before the presence
 * durability backstop picks up its unsettled session. Small enough to recover quickly, large enough
 * to never race the µs-window between a terminal path's `endMeeting` commit and its own
 * best-effort settlement call.
 */
export const PRESENCE_SETTLEMENT_GRACE_MINUTES = 2;

/**
 * BAL-586 — how long a meeting must have been ended, with its presence session still unsettled,
 * before `session.presence_stuck` alerts. ⚠ MUST EXCEED the backstop's own retry grace
 * ({@link PRESENCE_SETTLEMENT_GRACE_MINUTES}), or the alert would fire on sessions the backstop
 * has not yet had a chance to settle; `presence-settlement-timing.test.ts` pins the inequality.
 */
export const PRESENCE_UNSETTLED_ALERT_MS = 30 * 60_000;
