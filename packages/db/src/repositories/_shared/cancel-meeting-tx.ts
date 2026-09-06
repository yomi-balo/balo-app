import { and, eq, inArray, isNull } from 'drizzle-orm';
import { CANCELLABLE_MEETING_STATUSES } from '@balo/shared/meetings';
import { meetings } from '../../schema';
import { cancelProjectionTx } from './consultation-projection';
import { recordMeetingCancelled } from './meeting-audit';
import type { DbExecutor } from './db-executor';
// ⚠ TYPE-ONLY, AND THAT IS WHAT KEEPS THE GRAPH ACYCLIC. `meetings.ts` imports the FUNCTION
// below; this import is erased at compile time, so there is no runtime edge back. One
// definition of the result shape, no cycle.
import type { CancelMutationResult } from '../meetings';

/**
 * BAL-540 — the TRANSACTIONAL CORE of a meeting cancellation, on a `DbExecutor`, so that BOTH
 * `meetingsRepository.cancel` (which opens its own `db.transaction`) and the BAL-540 request
 * close cascade (which MUST stay in ONE transaction with the request write) drive the SAME
 * three steps in the SAME order against the SAME compare-and-set.
 *
 * ⚠⚠ WHY THE CASCADE MAY NOT SIMPLY CALL `meetingsRepository.cancel` (orchestrator D4).
 * That method opens its OWN `db.transaction`. Called from inside another one, in PRODUCTION
 * it takes a SECOND pooled connection and commits INDEPENDENTLY of the close — so a rolled
 * back close would leave the meetings cancelled. ⚠ AND NO TEST CAN SEE THIS: the integration
 * harness swaps `db` for the outer transaction (`test/setup-integration.ts`), which turns the
 * nested call into a SAVEPOINT on one connection, and the pool is pinned at `max: 1` so a
 * genuine second-connection race is inexpressible. A GREEN SUITE WOULD NOT CATCH THE MISTAKE.
 * The mechanical guard is `invariants/close-cascade-opens-one-transaction.test.ts`; this
 * extraction is what makes obeying it possible without duplicating the CAS.
 *
 * ⚠ IT RETURNS `undefined` ON A CAS MISS RATHER THAN THROWING, and the two callers want
 * opposite things from that:
 *   - `meetingsRepository.cancel` turns it into `MeetingNotCancellableError` (a user asked to
 *     cancel one specific meeting and is owed an answer).
 *   - the close cascade SKIPS it. A request-grain meeting somebody has ALREADY JOINED has
 *     flipped to `waiting_for_participants` and is un-cancellable BY STATE — orchestrator D1.
 *     `CANCELLABLE_MEETING_STATUSES` stays `['scheduled']`, is NOT widened, and NO second
 *     cascade-only status set is created: one tuple, consulted by the route guard and by this
 *     CAS, is the whole point. The residual (a joined discovery call survives a close) is
 *     deliberate, documented in the PR body, and pinned by an integration test.
 *
 * ⚠ POST-COMMIT WORK IS NOT HERE AND CANNOT BE. The credit-hold release, the Daily room
 * delete and any outbound publish all run POST-COMMIT in `apps/api`: `@balo/db` cannot
 * enqueue (`invariants/repositories-never-notify.test.ts` pins `meetings.ts`), the hold
 * release takes the wallet advisory lock in the opposite order, and a vendor HTTP call must
 * never be able to roll back a committed cancellation. Both callers return what the caller
 * needs to discharge that obligation — `expertProfileId` for the availability rebuild, and
 * `cancelAuditId` as the per-WRITE idempotency key.
 *
 * ── THE FULL SEQUENCE, IN ORDER, ALL ON `exec` ─────────────────────────────────
 *   1. The guarded compare-and-set — the TOCTOU backstop AND the shared definition of "which
 *      statuses may be cancelled".
 *   2. `cancelProjectionTx` — the `consultations` projection, and the read that tells the
 *      caller WHOSE availability cache to rebuild.
 *   3. `recordMeetingCancelled` — the audit row, LAST among the writes. An audit row left
 *      behind by a rolled-back cancel would attest to a cancellation that never happened.
 */
export async function cancelMeetingTx(
  exec: DbExecutor,
  id: string,
  audit: {
    actorUserId: string | null;
    /**
     * WHICH AUTHORIZATION ARM matched, or `'system'` for the ADR-1030 exemption. Server-derived
     * at the call site — never taken from request input.
     */
    actorRole: 'client' | 'expert' | 'admin' | 'system';
  }
): Promise<CancelMutationResult | undefined> {
  const now = new Date();
  // 1. Guarded compare-and-set.
  const [meeting] = await exec
    .update(meetings)
    // Enum literals at QUERY time are always safe — the house restriction is on index
    // predicates and CHECKs, which is why 0059 adds neither for this label.
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(meetings.id, id),
        inArray(meetings.status, [...CANCELLABLE_MEETING_STATUSES]),
        isNull(meetings.deletedAt)
      )
    )
    .returning();
  if (meeting === undefined) {
    return undefined;
  }

  // 2. The projection — the same instant the resolver's `confirmed`-only filter reopens
  //    the window.
  const expertProfileId = await cancelProjectionTx(exec, id);

  // 3. LAST. See the docblock: an audit row must never outlive a rolled-back cancel.
  const cancelAuditId = await recordMeetingCancelled(exec, {
    meetingId: meeting.id,
    actorUserId: audit.actorUserId,
    actorRole: audit.actorRole,
    scheduledStart: meeting.scheduledStart,
    scheduledEnd: meeting.scheduledEnd,
    expertProfileId,
  });

  return { meeting, expertProfileId, cancelAuditId };
}
