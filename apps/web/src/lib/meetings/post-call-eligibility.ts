import type { MeetingStatus } from '@balo/db';

/**
 * post-call-eligibility — MAY THIS MEETING'S CONSEQUENTIAL POST-CALL CONTROLS BE OFFERED, AND
 * HONOURED? **ONE DEFINITION, TWO ENFORCEMENT POINTS, TWO SURFACES.**
 *
 * THE RULE: `scheduled_start <= now` **AND** `status != 'cancelled'`.
 *
 * ⚠⚠ WHY THIS EXISTS. The end-of-call screen offered the rating capture AND the ONE-WAY
 * `case_engagements.close()` on a meeting that had not happened. `meetings.status` sits at
 * `scheduled` for 100% of rows today, so a client-company member who HAND-TYPED
 * `/meetings/{id}/end` for a FUTURE or CANCELLED consultation was told "Consultation complete",
 * asked to rate an expert they had not met, and offered an irreversible close. The recap has the
 * identical close exposure. Both are gated by this one predicate.
 *
 * ⚠⚠ `started_at` IS UNUSABLE AS A SIGNAL, AND THAT IS WHY THE RULE IS SHAPED THIS WAY.
 * **NOTHING WRITES IT.** There is no `markStarted` (nor any other `started_at` writer) on
 * `meetingsRepository` — BAL-134 owns the lifecycle transitions and is Backlog — so gating on
 * `started_at != null` would deny 100% of real rows and make the whole feature INERT. The same
 * goes for `status = 'ended'`. A guard that is always false is not a guard; it is a deletion.
 *
 * ⚠⚠ BOTH HALVES OF THIS RULE ARE **LIVE** SIGNALS TODAY, WHICH IS THE WHOLE POINT:
 *   · `meetings.scheduled_start` is `.notNull()` — every row has one, so the time half always
 *     decides something rather than degrading to "unknown ⇒ allow";
 *   · `status = 'cancelled'` IS written today, by `meetingsRepository.cancel()` (the BAL-410
 *     cancel seam, reached from `apps/api`'s `meeting-availability`), so the cancelled half is
 *     not a hypothetical branch either.
 *
 * ⚠⚠ ACCEPTED RESIDUAL — A NO-SHOW STILL QUALIFIES. A meeting whose `scheduled_start` has passed
 * but at which NOBODY TURNED UP passes this guard, because the platform has no evidence either
 * way (see `started_at`, above). That is accepted, not overlooked: the close ALREADY requires a
 * client-company member (`hasCapability(PARTICIPATE, { companyId })` on the membership axis —
 * ADR-1029) **plus** a mandatory confirmation step, so the worst case is a legitimate member
 * deliberately closing their OWN case after a no-show — arguably their call to make. **BAL-134**
 * is the ticket that tightens this to `started_at != null`; when its transitions ship, the time
 * half becomes redundant and the stamp becomes the honest signal.
 *
 * ⚠ THE CLOCK IS INJECTED, NEVER READ FROM A MODULE-LEVEL `Date`. Both callers can therefore be
 * proven deterministically at the exact boundary, which matters for a guard whose whole job is a
 * comparison against `now`.
 *
 * ⚠ TYPE-ONLY `@balo/db` IMPORT, DELIBERATELY. `MeetingStatus` is erased at build, so this
 * module never drags `postgres` toward a bundle (memory `reference_balo_db_client_bundle_footgun`)
 * — the same posture `end-of-call-view-types.ts` documents. It is otherwise a pure,
 * dependency-free, I/O-free module with no `server-only` marker, exactly like its neighbour
 * `meeting-duration.ts`.
 */

/**
 * The two meeting facts this rule reads — and the ONLY two. A full `Meeting` row satisfies it;
 * nothing here may grow to need `joinUrl`, `dailyRoomName` or anything else.
 */
export interface PostCallMeetingFacts {
  /** `meetings.scheduled_start`. NOT NULL in the schema, so never optional here. */
  scheduledStart: Date;
  /** `meetings.status`. Only `cancelled` is consulted — see the docblock. */
  status: MeetingStatus;
}

/**
 * Has this meeting reached the point where a rating may be asked for and a case may be closed?
 *
 * @param now injected so the boundary is testable; defaults to the wall clock.
 */
export function meetingAllowsPostCallActions(
  meeting: Readonly<PostCallMeetingFacts>,
  now: Date = new Date()
): boolean {
  if (meeting.status === 'cancelled') {
    return false;
  }
  return meeting.scheduledStart.getTime() <= now.getTime();
}
