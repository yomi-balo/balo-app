import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { meetings } from '../../schema';
import { meetingPresenceRepository } from '../meeting-presence';
import { recordMeetingAudit } from './meeting-audit';
import type { DbExecutor } from './db-executor';
// ⚠ TYPE-ONLY, the `cancel-meeting-tx.ts` precedent: `meetings.ts` imports the FUNCTION below,
// and this import is erased at compile time, so there is no runtime edge back.
import type { EndMeetingInput, EndMeetingResult } from '../meetings';

/**
 * Internal control signal — the meeting was ALREADY terminal, so the savepoint below must roll
 * back and the core must answer `undefined`. Never escapes this module.
 *
 * ⚠ WHY A THROW RATHER THAN AN EARLY RETURN. The presence close runs BEFORE the status
 * compare-and-set (the R5 ordering, preserved), so by the time the CAS reports "already
 * terminal" this transaction may already have closed intervals. Returning at that point would
 * COMMIT those closures on a call that is meant to be a pure no-op (D10: the losing ender gets
 * an idempotent `200` with no second effect, no second audit row, no second teardown).
 * Throwing rolls the savepoint back, so "returned undefined" and "changed nothing" are the same
 * statement — the only contract a caller can safely retry against, and the one a caller that
 * keeps writing on the same transaction afterwards (`meetingRingsRepository.endRing`) relies on.
 */
class MeetingAlreadyTerminalSignal extends Error {
  constructor() {
    super('meeting already terminal');
    this.name = 'MeetingAlreadyTerminalSignal';
  }
}

/**
 * BAL-134 / ADR-1049 — the TRANSACTIONAL CORE of the terminal transition, on a `DbExecutor`, so
 * that `meetingsRepository.endMeeting` and the Call now `no_answer` paths
 * (`meetingRingsRepository.endRing` / `endNoAnswerMeeting`, which must end the meeting in the
 * SAME transaction as their own writes) drive the same steps against the same
 * compare-and-set. See `endMeeting`'s docblock for the reasoning behind each step; change the
 * sequence HERE, never in a caller.
 *
 * Runs inside its OWN `exec.transaction` — a SAVEPOINT when `exec` is already a transaction, a
 * transaction when it is the base client — so a CAS miss rolls back exactly this core's writes
 * and leaves the caller's transaction usable.
 *
 * ⚠ THE CALLER ASSERTS THE EDGES. `assertEveryEdgeLegal(END_MEETING_FROM, 'ended')` is pure and
 * runs OUTSIDE any transaction, in the caller.
 *
 * ── THE SEQUENCE, IN ORDER ─────────────────────────────────────────────────────
 *   1. `meetingPresenceRepository.closeAllOpen` — presence closed FIRST, clamped to `endedAt`.
 *   2. The compare-and-set: `status='ended'`, `ended_at`, `ended_by` and `outcome` in ONE
 *      statement (`resolveClockCeiling` depends on it), as an EXCLUSION of the two terminal
 *      statuses.
 *   3. The `meeting.ended` audit row, LAST.
 *
 * Returns `undefined` — having changed nothing — when the CAS matches nothing (already `ended`,
 * already `cancelled`, soft-deleted, or gone).
 */
export async function endMeetingTx(
  exec: DbExecutor,
  input: EndMeetingInput
): Promise<EndMeetingResult | undefined> {
  try {
    return await exec.transaction(async (tx) => {
      const closedIntervals = await meetingPresenceRepository.closeAllOpen(
        input.id,
        input.endedAt,
        tx
      );

      const [meeting] = await tx
        .update(meetings)
        .set({
          status: 'ended',
          endedAt: input.endedAt,
          endedBy: input.endedBy,
          outcome: input.outcome,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(meetings.id, input.id),
            // Enum literals at QUERY time are always safe — the house restriction is on
            // index predicates and CHECKs.
            notInArray(meetings.status, ['ended', 'cancelled']),
            isNull(meetings.deletedAt)
          )
        )
        .returning();

      if (meeting === undefined) {
        throw new MeetingAlreadyTerminalSignal();
      }

      // LAST, and on `tx` — an audit row left behind by a rolled-back termination would
      // attest to an end that never happened.
      await recordMeetingAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'meeting.ended',
        meetingId: meeting.id,
        metadata: {
          endedBy: input.endedBy,
          outcome: input.outcome,
          closedIntervals,
          // ⚠ ISO STRING, NOT `Date` — `metadata` is `jsonb`, so a `Date` round-trips as a
          // string and typing it otherwise would be a lie on the way back out (memory
          // `reference_jsonb_date_type_lie`). The same conversion `recordMeetingBooked` does.
          endedAt: input.endedAt.toISOString(),
          ...(input.terminalRule === undefined
            ? {}
            : { terminalRule: input.terminalRule.rule, terminalArm: input.terminalRule.arm }),
        },
      });

      return { meeting, closedIntervals };
    });
  } catch (error) {
    if (error instanceof MeetingAlreadyTerminalSignal) {
      return undefined;
    }
    throw error;
  }
}
