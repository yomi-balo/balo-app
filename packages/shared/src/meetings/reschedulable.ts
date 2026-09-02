import type { MeetingLifecycleStatus } from './lifecycle';

/**
 * BAL-409 (orchestrator D-B) — MAY THIS MEETING BE RESCHEDULED RIGHT NOW?
 *
 * ⚠⚠ AN ALLOW-LIST, NOT A TERMINAL SET, AND THAT IS THE WHOLE POINT. `MEETING_CLOSED_TO_JOIN`
 * (`./closed-to-join`, a sibling in this same directory since BAL-513) names what is CLOSED so a
 * sixth `meeting_status` label defaults to OPEN — correct for a join, WRONG here. This names what
 * is OPEN, so a sixth label is DENIED BY DEFAULT and somebody has to decide consciously.
 * `reschedulable.test.ts` pins that with a table over every status.
 *
 * ⚠ `waiting_for_participants` IS EXCLUDED, SETTLING THE ASYMMETRY `repositories/meetings.ts:539-562`
 * assigned to this ticket — IN THE RESCHEDULE DIRECTION ONLY. ⚠ BAL-410 HAS SINCE SETTLED THE
 * CANCEL DIRECTION, in `cancellable.ts` (orchestrator D5): `CANCELLABLE_MEETING_STATUSES` is
 * `['scheduled']` too, so the two guards now AGREE on status and neither asymmetry is open any
 * more. They still disagree on exactly ONE state, deliberately — a past-start, NEVER-JOINED
 * `scheduled` meeting is `already_started` here and STILL CANCELLABLE there, because with no
 * presence there is no no-show to settle. Read `cancellable.ts`'s docblock before "aligning"
 * them. Three reasons the window may not move once it has opened:
 *   1. the ticket's own AC ("reschedule is unavailable once the meeting has started");
 *   2. moving it leaves a STALE status — the `waiting_for_participants → scheduled` back-edge is
 *      declared legal and DELIBERATELY unimplemented (`lifecycle.ts:59-66`, D12) because the
 *      presence rows from the pre-reschedule attempt are a BILLING question (BAL-412's). Do not
 *      implement that back-edge here;
 *   3. it leaves no open presence interval spanning a move.
 *
 * ⚠ FAILS CLOSED ON A NON-FINITE INSTANT, same posture and same reason as `validateBookingWindow`:
 * BAL-409's route may parse with `z.coerce.date()`, where an unparseable input is an Invalid Date
 * rather than a Zod issue.
 *
 * ⚠⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER — see `meetings/index.ts`'s
 * own warning (memory `reference_balo_shared_no_js_extensions_in_reexports`).
 *
 * PURE. `now` is INJECTED — this module reads no clock.
 */
export const RESCHEDULABLE_MEETING_STATUSES = [
  'scheduled',
] as const satisfies readonly MeetingLifecycleStatus[];

export type RescheduleRefusal = 'invalid_instant' | 'status_not_reschedulable' | 'already_started';

/**
 * `null` ⇒ reschedulable. Order is part of the contract and is pinned by the test:
 * `invalid_instant` → `status_not_reschedulable` → `already_started`.
 *
 * `scheduledStart === now` counts as started (denied) — a reschedule must move the window into
 * the future, and a boundary of exactly "now" is not meaningfully still ahead of it.
 */
export function resolveRescheduleRefusal(
  status: MeetingLifecycleStatus,
  scheduledStart: Date,
  now: Date
): RescheduleRefusal | null {
  const scheduledStartMs = scheduledStart.getTime();
  const nowMs = now.getTime();

  if (!Number.isFinite(scheduledStartMs) || !Number.isFinite(nowMs)) {
    return 'invalid_instant';
  }
  if (!(RESCHEDULABLE_MEETING_STATUSES as readonly MeetingLifecycleStatus[]).includes(status)) {
    return 'status_not_reschedulable';
  }
  if (scheduledStartMs <= nowMs) {
    return 'already_started';
  }
  return null;
}
