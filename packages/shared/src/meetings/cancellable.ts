import type { MeetingLifecycleStatus } from './lifecycle';

/**
 * BAL-410 (orchestrator D5) — MAY THIS MEETING BE CANCELLED RIGHT NOW?
 *
 * The cancel-side sibling of `reschedulable.ts`, and the ONE definition of "which statuses may
 * be cancelled" — shared by the route guard (`routes/meetings/cancel.ts`) and the repository
 * compare-and-set (`meetingsRepository.cancel`), so the two cannot drift.
 *
 * ⚠⚠ AN ALLOW-LIST, NOT A TERMINAL SET, AND THAT IS THE WHOLE POINT — the same argument
 * `reschedulable.ts` makes. `MEETING_CLOSED_TO_JOIN` (`./closed-to-join`, a sibling in this same
 * directory since BAL-513) names what is CLOSED so a sixth `meeting_status` label defaults to
 * OPEN, which is correct for a join and WRONG here. This names what is OPEN, so a sixth label is
 * DENIED BY DEFAULT and somebody has to decide consciously. `cancellable.test.ts` pins that with
 * a table over every status.
 *
 * ⚠⚠ IT TAKES NO `now` AND NO `scheduledStart`, UNLIKE `resolveRescheduleRefusal`. That
 * asymmetry IS orchestrator decision D5, not an oversight, and it settles the "undecided"
 * ruling `repositories/meetings.ts` assigned to this ticket. The AC — "cancellation is
 * unavailable once the meeting has started" — is delivered by STATE, not by a clock: the first
 * presence interval flips `scheduled → waiting_for_participants`
 * (`services/meetings/presence-writer.ts`), and the `waiting_for_participants → scheduled`
 * back-edge is declared legal but DELIBERATELY unimplemented (`lifecycle.ts`), so that flip is
 * monotone. A meeting anybody has actually joined is therefore already un-cancellable with no
 * clock read anywhere. ⚠ DO NOT ADD A CLOCK COMPARISON HERE — the ticket forbids inventing a
 * cutoff ("free until scheduled start", no fee schedule) and D5 settles it.
 *
 * ⚠ THE KNOWN RESIDUAL, STATED RATHER THAN HIDDEN. A `scheduled` meeting whose start has
 * PASSED but which NOBODY JOINED stays cancellable until the lifecycle sweep terminates it.
 * `resolveRescheduleRefusal` would refuse that same meeting (`already_started`), so the two
 * guards deliberately DISAGREE on exactly one state. That is correct: with no presence there is
 * no no-show to settle (BAL-412's path is driven by presence rows), so cancelling is the honest
 * outcome and charges nobody. The consequence for analytics is that `hours_before_start` can be
 * NEGATIVE — "cancelled after the scheduled start, nobody joined", not bad data.
 *
 * ⚠⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER — see `meetings/index.ts`'s
 * own warning (memory `reference_balo_shared_no_js_extensions_in_reexports`).
 *
 * PURE. Reads no clock, performs no I/O.
 */
export const CANCELLABLE_MEETING_STATUSES = [
  'scheduled',
] as const satisfies readonly MeetingLifecycleStatus[];

/** The single refusal shape. There is deliberately no `already_started` — see the docblock. */
export type CancelRefusal = 'status_not_cancellable';

/** `null` ⇒ cancellable. PURE — takes no clock, by decision D5. */
export function resolveCancelRefusal(status: MeetingLifecycleStatus): CancelRefusal | null {
  return (CANCELLABLE_MEETING_STATUSES as readonly MeetingLifecycleStatus[]).includes(status)
    ? null
    : 'status_not_cancellable';
}
