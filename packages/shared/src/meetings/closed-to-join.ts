import type { MeetingLifecycleStatus } from './lifecycle';

/**
 * BAL-132 / BAL-513 — THE MEETING STATUSES THAT CLOSE A MEETING TO JOINING. ONE definition, for
 * BOTH the server gate (`apps/api` `assertMeetingJoinable`) and the expert calendar's Join
 * affordance (`apps/web` `calendarJoinAffordanceVisible`).
 *
 * ⚠⚠ A **TERMINAL** SET, NOT AN ALLOW-LIST — the identical ruling as `MEETING_CLOSED_TO_GUESTS`,
 * and for the identical reason. `meeting_status` has FIVE labels, and an
 * `IN ('scheduled','in_progress')` allow-list would silently exclude `waiting_for_participants`,
 * which is PRECISELY the state a call is in while people are arriving — i.e. the state in which
 * joining matters most. Naming what is CLOSED means a SIXTH label added later defaults to OPEN,
 * which is the correct direction for a join. `cancellable.ts` and `reschedulable.ts` make the
 * MIRROR argument for their own direction: read all three before "aligning" any of them.
 *
 * ⚠ IT MOVED HERE FROM `apps/api/src/services/meetings/meeting-liveness.ts` (BAL-513 D2) because
 * `apps/web` cannot import `apps/api`, and the alternative was a second hand-list of terminal
 * statuses in the web app — which is exactly the drift this set exists to prevent.
 *
 * ⚠ TYPED AS `MeetingLifecycleStatus`, NOT `string`. A bare `string` set accepts any literal, so a
 * typo or a renamed pgEnum label would silently OPEN the gate with no typecheck failure — the one
 * direction a fail-closed check must never drift in. `MeetingLifecycleStatus` is the hand-restated
 * five-label union; `apps/api/src/services/meetings/meeting-state.ts`'s
 * `AssertMeetingLifecycleLabelsMatch` is what pins it to `@balo/db`'s real `MeetingStatus`, so a
 * sixth pgEnum label fails `pnpm typecheck` there.
 *
 * ⚠ A FUTURE `ALTER TYPE … ADD VALUE` ON `meeting_status` MUST SWEEP THIS SET, as the schema
 * docblock in `enums.ts` demands.
 *
 * ⚠⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER — see `meetings/index.ts`.
 *
 * PURE. Reads no clock, performs no I/O, client-bundle-safe.
 */
export const MEETING_CLOSED_TO_JOIN: ReadonlySet<MeetingLifecycleStatus> = new Set([
  'ended',
  'cancelled',
]);

/** `true` when this status closes the meeting to joining. The predicate form, so callers never
 *  reach into the Set and a future non-Set representation stays a private detail. */
export function meetingIsClosedToJoin(status: MeetingLifecycleStatus): boolean {
  return MEETING_CLOSED_TO_JOIN.has(status);
}
