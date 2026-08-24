import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { meetingGuests } from '../../schema';
import type { DbExecutor } from './db-executor';

/**
 * BAL-409 — THE TX-SCOPED GUEST-EXPIRY WRITER, lifted from
 * `meetingGuestsRepository.extendExpiryForMeeting`'s body so a reschedule can run it on the
 * SAME `tx` as `meetingsRepository.updateSchedule`'s other writes.
 *
 * ⚠ NOT A VERBATIM LIFT — THE PREDICATE WAS NARROWED. The extend-only condition is preserved,
 * but an `admission IN ('admitted','pre_admitted')` filter was ADDED that the original lacked
 * (see the B7 note below). The public method's signature is unchanged and its extend-only
 * contract is unchanged, but its EFFECT is deliberately narrower than before: rows for
 * never-admitted lobby knocks are no longer touched.
 *
 * A `_shared/` internal, deliberately NOT barrel-exported — matching `_shared/consultation-
 * projection.ts`'s writers. `meetingGuestsRepository.extendExpiryForMeeting` now DELEGATES to
 * this function (bound to the base `db`), so the public signature and behaviour are unchanged
 * and its own integration suite stays green.
 *
 * Push every LIVE, ADMITTED guest link on a meeting out to a LATER expiry, returning how many
 * rows moved.
 *
 * ⚠ B7 — `admission IN ('admitted','pre_admitted')`, DELIBERATELY NARROWER THAN "LIVE"
 * (`deleted_at`/`revoked_at` only). Without it, every reschedule also pushed the expiry of
 * NEVER-ADMITTED lobby knocks (`admission = 'pending'`) — AND of handles that had ALREADY
 * EXPIRED — out to `newEnd + 7d`. `findLiveByTokenHash` (the lobby re-entry check) needs only
 * `expires_at > now()` AND `admission <> 'denied'`, so an expired `pending` handle would be
 * silently RESURRECTED into a working lobby token on the very next reschedule, with no host
 * ever having admitted it. Mirrors the same admission narrowing `meeting-availability.ts`'s
 * `publishGuestRescheduledNotifications` applies to its own read of this table (B1) — an
 * unadmitted or already-expired handle gets neither a notification nor a resurrected expiry.
 *
 * EXTEND-ONLY by construction (`expires_at < newExpiresAt`): moving a meeting EARLIER must
 * never silently shorten a window, because a shortened window is a revocation nobody decided
 * on — and revocation has its own attributed path (`revoke`).
 */
export async function extendGuestExpiryForMeetingTx(
  exec: DbExecutor,
  meetingId: string,
  expiresAt: Date
): Promise<number> {
  const rows = await exec
    .update(meetingGuests)
    .set({ expiresAt, updatedAt: sql`now()` })
    .where(
      and(
        eq(meetingGuests.meetingId, meetingId),
        isNull(meetingGuests.deletedAt),
        isNull(meetingGuests.revokedAt),
        inArray(meetingGuests.admission, ['admitted', 'pre_admitted']),
        lt(meetingGuests.expiresAt, expiresAt)
      )
    )
    .returning({ id: meetingGuests.id });
  return rows.length;
}
