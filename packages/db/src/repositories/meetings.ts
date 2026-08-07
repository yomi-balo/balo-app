import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  meetings,
  meetingContexts,
  type Meeting,
  type MeetingContext,
  type MeetingContextType,
  type NewMeeting,
} from '../schema';
import {
  cancelProjectionTx,
  projectNewMeetingTx,
  softDeleteProjectionTx,
  syncProjectionScheduleTx,
} from './_shared/consultation-projection';
import type { DbExecutor } from './_shared/db-executor';

/**
 * Thrown by `create` when the `contexts` array is empty.
 *
 * "Every meeting has ≥1 context row" CANNOT be a DB constraint (it needs a deferrable
 * constraint or a trigger — out of scope), so it is enforced at the SINGLE write path.
 */
export class MeetingContextRequiredError extends Error {
  constructor() {
    super('A meeting requires at least one context (decision B / ADR-1045 §2)');
    this.name = 'MeetingContextRequiredError';
  }
}

/**
 * Thrown by `cancel` when the meeting is not in a cancellable state — already cancelled,
 * already started or ended, soft-deleted, or simply not there. A NAMED error so BAL-410's
 * route branches on a type rather than string-matching.
 */
export class MeetingNotCancellableError extends Error {
  constructor(public readonly meetingId: string) {
    super(`Meeting ${meetingId} is not cancellable (must be live and status='scheduled')`);
    this.name = 'MeetingNotCancellableError';
  }
}

/**
 * Thrown by `updateSchedule` when the meeting is not in a reschedulable state — cancelled,
 * in progress, ended, soft-deleted, or simply not there. A NAMED error so BAL-409/BAL-411's
 * routes branch on a type rather than string-matching.
 *
 * The cancelled case is the load-bearing one: rescheduling a cancelled meeting used to
 * succeed and produce a live meeting whose projection stayed `cancelled` — a booking that
 * blocked nobody, invisible to `findProjectionDrift`. See `updateSchedule`'s docblock.
 */
export class MeetingNotReschedulableError extends Error {
  constructor(public readonly meetingId: string) {
    super(
      `Meeting ${meetingId} is not reschedulable (must be live and status='scheduled' or 'waiting_for_participants')`
    );
    this.name = 'MeetingNotReschedulableError';
  }
}

/** One context attachment. `contextId` is NULL only for `'admin'` (the DB CHECK enforces it). */
export interface MeetingContextInput {
  contextType: MeetingContextType;
  contextId: string | null;
}

export interface CreateMeetingInput {
  scheduledStart: Date;
  scheduledEnd: Date;
  /** ≥1 required — the "every meeting has a context row" invariant (decision B). */
  contexts: MeetingContextInput[];
  dailyRoomName?: string | null;
  joinUrl?: string | null;
}

export interface MeetingWithContexts {
  meeting: Meeting;
  contexts: MeetingContext[];
}

/**
 * The return shape of EVERY mutator that can move an expert's availability (BAL-428).
 *
 * ⚠ `expertProfileId` IS PART OF THE RETURN TYPE ON PURPOSE, and the caller's obligation is
 * spelled out on `meetingsRepository` below: whoever mutates a meeting must rebuild that
 * expert's availability cache POST-COMMIT. Returning it means the caller cannot forget WHO
 * to rebuild for, and cannot get it wrong by re-deriving it.
 *
 * `null` means "nothing to rebuild" — an admin meeting, which projects no consultation row
 * and occupies nobody's calendar.
 */
export interface MeetingMutationResult {
  meeting: Meeting;
  expertProfileId: string | null;
}

/** `create`'s result: the meeting, its context rows, AND who was booked. */
export interface CreatedMeeting extends MeetingMutationResult {
  contexts: MeetingContext[];
}

/**
 * Re-assert `scheduled_start < scheduled_end` in-process. Shared by `create` and
 * `updateSchedule` so both entry points reject an inverted window with the SAME typed
 * error, rather than one raising a raw `23514` and the other a named one. The DB CHECK
 * `meeting_scheduled_start_before_end` is still the backstop.
 */
function assertScheduleOrder(scheduledStart: Date, scheduledEnd: Date): void {
  if (scheduledStart.getTime() >= scheduledEnd.getTime()) {
    throw new Error('Meeting scheduled_start must be before scheduled_end');
  }
}

/**
 * Patch ONE live meeting, stamping `updated_at`, and throw a named not-found error when
 * nothing live matches. Shared by every field-level mutator so the live-row guard and the
 * error text are defined exactly once.
 *
 * Takes an optional executor so a mutator that must also move the `consultations`
 * projection can run BOTH writes on the SAME transaction (BAL-428). Defaults to the base
 * client for the standalone mutators.
 */
async function updateLiveMeeting(
  id: string,
  set: Partial<NewMeeting>,
  exec: DbExecutor = db
): Promise<Meeting> {
  const [updated] = await exec
    .update(meetings)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)))
    .returning();
  if (updated === undefined) {
    throw new Error(`Meeting not found: ${id}`);
  }
  return updated;
}

/**
 * `meetingsRepository` (BAL-418 / ADR-1045 §2) — the Meeting primitive's write + read
 * surface.
 *
 * ⚠ DELIBERATELY NO STATUS MUTATOR — WITH ONE EXCEPTION. `start()` / `end()` / the
 * transition map are **BAL-134's**, so the lifecycle is defined in exactly ONE place. The
 * exception is `cancel()`, added by BAL-428: cancelling is what FREES A BOOKED SLOT, so it
 * cannot live outside the module that owns the projection. Tests drive every other
 * non-`scheduled` state through `meetingFactory`'s `values` override (the
 * `transcript.factory` precedent).
 *
 * ⚠⚠ THE CALLER'S POST-COMMIT OBLIGATION (BAL-428) — READ THIS BEFORE WIRING THE FIRST
 * CALLER, in the same register as `caseEngagementsRepository.close()`'s BAL-390 contract.
 *
 * `create` / `updateSchedule` / `cancel` / `softDelete` all MOVE AN EXPERT'S AVAILABILITY,
 * because each writes the `consultations` projection the availability resolver subtracts
 * from. The cached `earliest_available_at` for that expert is stale the instant any of them
 * commits. This repository CANNOT refresh it: the rebuild runs on a BullMQ queue that lives
 * only in `apps/api`, and `@balo/db` depends on nothing that can reach a queue (the
 * `repositories-never-notify` invariant pins that). So EVERY caller MUST, POST-COMMIT,
 * enqueue an availability-cache rebuild for the `expertProfileId` these methods return.
 * That id is returned FOR THAT PURPOSE — `null` means there is nothing to rebuild.
 *
 * ⚠ A COROLLARY WORTH STATING PLAINLY: **a booking cannot be a pure web Server Action.**
 * The queue exists only in `apps/api`, so a `apps/web` action that called `create` directly
 * would commit a booking and leave every expert-facing surface advertising a slot that is
 * already taken. Booking goes through the API service layer.
 *
 * ⚠ AND THE INVERSE: none of these methods notifies. Booking confirmations are BAL-129's,
 * cancellations BAL-410's, reschedules BAL-409/BAL-411's. Publishing from here would fire
 * on a dev seed run, since the seeder is a live caller of `create` and `cancel`.
 */
export const meetingsRepository = {
  /**
   * Insert the meeting, its context rows AND its `consultations` projection in ONE
   * transaction — a meeting can never exist without a context, even transiently, and
   * (BAL-428) a booked meeting can never exist without blocking its expert's calendar.
   * Throws `MeetingContextRequiredError` on an empty `contexts` array (before any write).
   *
   * THE EXPERT IS RESOLVED HERE, AT WRITE TIME, from the contexts (see
   * `_shared/consultation-projection.ts`). A booking that cannot name exactly one expert
   * throws — `MeetingExpertAmbiguousError`, `MatchModeDiscoveryNotBookableError` or
   * `MeetingContextUnresolvableError` — and the WHOLE meeting rolls back. An admin-only
   * meeting resolves to `null`, writes no projection row, and blocks nobody.
   *
   * `scheduledStart < scheduledEnd` is re-asserted in-process, MIRRORING `updateSchedule`,
   * so the SAME invariant surfaces as the SAME typed error from BOTH entry points rather
   * than a raw `23514` from one and a named error from the other. The CHECK
   * `meeting_scheduled_start_before_end` remains the backstop.
   */
  async create(input: CreateMeetingInput): Promise<CreatedMeeting> {
    if (input.contexts.length === 0) {
      throw new MeetingContextRequiredError();
    }
    assertScheduleOrder(input.scheduledStart, input.scheduledEnd);

    return db.transaction(async (tx) => {
      const [meeting] = await tx
        .insert(meetings)
        .values({
          scheduledStart: input.scheduledStart,
          scheduledEnd: input.scheduledEnd,
          dailyRoomName: input.dailyRoomName ?? null,
          joinUrl: input.joinUrl ?? null,
        })
        .returning();
      if (meeting === undefined) {
        throw new Error('Failed to insert meeting');
      }

      const contexts = await tx
        .insert(meetingContexts)
        .values(
          input.contexts.map((context) => ({
            meetingId: meeting.id,
            contextType: context.contextType,
            contextId: context.contextId,
          }))
        )
        .returning();
      if (contexts.length !== input.contexts.length) {
        throw new Error(`Failed to attach contexts to meeting: ${meeting.id}`);
      }

      const expertProfileId = await projectNewMeetingTx(tx, meeting, input.contexts);

      return { meeting, contexts, expertProfileId };
    });
  },

  /** ONE live meeting by id. `undefined` when missing or soft-deleted. */
  async findById(id: string): Promise<Meeting | undefined> {
    const [row] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * ONE live meeting plus its live context rows — "what is this meeting, and what is it
   * FOR". `undefined` when the meeting is missing or soft-deleted.
   */
  async findWithContexts(id: string): Promise<MeetingWithContexts | undefined> {
    const meeting = await this.findById(id);
    if (meeting === undefined) {
      return undefined;
    }
    const contexts = await db
      .select()
      .from(meetingContexts)
      .where(and(eq(meetingContexts.meetingId, meeting.id), isNull(meetingContexts.deletedAt)));
    return { meeting, contexts };
  },

  /**
   * BAL-129/BAL-131 webhook resolution — a Daily room resolves to exactly ONE live
   * meeting. Rides `meeting_daily_room_name_idx`.
   */
  async findByDailyRoomName(dailyRoomName: string): Promise<Meeting | undefined> {
    const [row] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.dailyRoomName, dailyRoomName), isNull(meetings.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * BAL-129 PROVISIONING SEAM — stamp the Daily room + join url once the room exists.
   * BAL-418 ships the seam; BAL-129 is the only caller that will ever exist.
   */
  async setVenue(id: string, venue: { dailyRoomName: string; joinUrl: string }): Promise<Meeting> {
    return updateLiveMeeting(id, {
      dailyRoomName: venue.dailyRoomName,
      joinUrl: venue.joinUrl,
    });
  },

  /**
   * BAL-409 RESCHEDULE SEAM. Moves the meeting AND its projection in ONE transaction, so
   * the old window is never free-and-booked or booked-and-free between two commits.
   * Re-asserts `start < end` in-process so the caller gets a named error rather than a raw
   * `23514` from `meeting_scheduled_start_before_end` (which remains the backstop).
   *
   * ⚠ RETURNS `MeetingMutationResult`, NOT `Meeting` (changed by BAL-428) — the caller
   * needs the `expertProfileId` to rebuild the availability cache post-commit. That expert
   * is read from the LIVE PROJECTION ROW, never re-resolved from the contexts; see
   * `syncProjectionScheduleTx` for why re-resolving would be a silent repoint.
   *
   * ⚠ THE GUARD SETS HERE AND ON `cancel()` ARE NOT THE SAME, AND THAT ASYMMETRY IS
   * UNDECIDED — NOT A RULING. `cancel()` allows `scheduled` ONLY; this allows `scheduled`
   * AND `waiting_for_participants`. So once the Daily room opens, a meeting can be MOVED but
   * not CANCELLED. Two consequences a route author will meet before anyone else does:
   *   · rescheduling a `waiting_for_participants` meeting into next week leaves it AT
   *     `waiting_for_participants` with a future window — nothing transitions it back to
   *     `scheduled`, because BAL-134 owns transitions and has not landed;
   *   · if a participant had already joined, that meeting carries an open presence interval
   *     across the move (`meeting-presence.ts`'s `resolveClockCeiling` residual).
   * Each guard was written for its own reason — `cancel` narrow because cancelling is what
   * frees a slot, this one wider because a client may legitimately move a call in the minutes
   * before it starts — so the asymmetry is an ACCIDENT OF TWO LOCAL DECISIONS, not a product
   * position. **BAL-409/BAL-410/BAL-411 must settle it explicitly**: either widen `cancel` to
   * `waiting_for_participants` (and revisit the presence residual, which currently leans on
   * `cancel`'s narrowness), or narrow this one to `scheduled` and require cancel-then-rebook
   * once the room is open. Do not let the first route to land decide it by omission.
   *
   * ⚠⚠ GUARDED AT ALL FOR A SHARPER REASON THAN THE ABOVE. Without any status guard,
   * CANCEL-THEN-
   * RESCHEDULE REOPENS EXACTLY THE DOUBLE-BOOKING THIS TICKET CLOSES, in the one shape the
   * reconciliation read cannot see:
   *
   *   1. Book M for 09:00–10:00 → meeting `scheduled`, projection `confirmed`.
   *   2. `cancel(M)` → meeting `cancelled`, projection `cancelled`. Slot correctly freed.
   *   3. `updateSchedule(M, 14:00–15:00)` — `syncProjectionScheduleTx` moves `start_at` /
   *      `end_at` but DELIBERATELY never recomputes `status`, so the projection stays
   *      `cancelled` while the meeting is live at 14:00–15:00.
   *   4. `listConfirmedInRange` filters `status='confirmed'` and skips it ⇒ a LIVE MEETING
   *      THAT BLOCKS NOBODY. A second client books 14:00–15:00 and both commit.
   *   5. `findProjectionDrift` reports NOTHING: the two representations AGREE
   *      (`consultationStatusForMeeting('cancelled') === 'cancelled'`). The drift read built
   *      to catch "a booking that blocks nobody" is structurally blind to this one.
   *   6. Worse, `afterMeetingMutation` still gets a non-null `expertProfileId` and enqueues a
   *      rebuild — so the platform actively RE-ADVERTISES the slot as free.
   *
   * `ended` and `in_progress` are excluded for the same reason plus an independent one: a
   * delivered or running call must not be silently moved into the future.
   *
   * ⚠ IF RESCHEDULE-AFTER-CANCEL IS EVER MADE LEGAL (a "revive"), `syncProjectionScheduleTx`
   * MUST re-derive `status` from `meeting.status` in the same change, and `cancel()`'s guard
   * must be revisited. What must never exist again is the third state, where it half-works.
   *
   * ⚠ THE WALL-CLOCK RULE IS NOT HERE, matching `cancel()`: BAL-409/BAL-411's "how late may
   * you move it" policy belongs at the CALL SITE.
   */
  async updateSchedule(
    id: string,
    schedule: { scheduledStart: Date; scheduledEnd: Date }
  ): Promise<MeetingMutationResult> {
    assertScheduleOrder(schedule.scheduledStart, schedule.scheduledEnd);

    return db.transaction(async (tx) => {
      const [meeting] = await tx
        .update(meetings)
        .set({
          scheduledStart: schedule.scheduledStart,
          scheduledEnd: schedule.scheduledEnd,
          updatedAt: new Date(),
        })
        // Enum literals at QUERY time are always safe — the house restriction is on index
        // predicates and CHECKs, which is why 0059 adds neither for this label.
        .where(
          and(
            eq(meetings.id, id),
            inArray(meetings.status, ['scheduled', 'waiting_for_participants']),
            isNull(meetings.deletedAt)
          )
        )
        .returning();
      if (meeting === undefined) {
        throw new MeetingNotReschedulableError(id);
      }

      const expertProfileId = await syncProjectionScheduleTx(tx, meeting);
      return { meeting, expertProfileId };
    });
  },

  /**
   * BAL-410 CANCEL SEAM — THE ONLY THING THAT FREES A BOOKED SLOT. Flips the meeting to
   * `status='cancelled'` and its projection to `status='cancelled'` in ONE transaction, so
   * the resolver's `confirmed`-only filter re-opens the window at the same instant.
   *
   * GUARDED ON `status='scheduled' AND deleted_at IS NULL`, and throws
   * `MeetingNotCancellableError` otherwise: a meeting that already started, already ended,
   * or was already cancelled must not silently "cancel" again and re-fire whatever the
   * caller does post-commit.
   *
   * ⚠ THE WALL-CLOCK RULE IS NOT HERE. BAL-410's "free to cancel until the scheduled start"
   * policy stays at the CALL SITE, exactly as `caseEngagementsRepository.close()` leaves
   * capability checks to its caller. A repository that read the clock would make every
   * fixture and every backfill subject to a product policy that can change.
   */
  async cancel(id: string): Promise<MeetingMutationResult> {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [meeting] = await tx
        .update(meetings)
        // Enum literals at QUERY time are always safe — the house restriction is on index
        // predicates and CHECKs, which is why 0059 adds neither for this label.
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(eq(meetings.id, id), eq(meetings.status, 'scheduled'), isNull(meetings.deletedAt))
        )
        .returning();
      if (meeting === undefined) {
        throw new MeetingNotCancellableError(id);
      }

      const expertProfileId = await cancelProjectionTx(tx, id);
      return { meeting, expertProfileId };
    });
  },

  /**
   * Soft-delete a meeting, its context rows AND its `consultations` projection in ONE
   * transaction.
   *
   * ⚠ RETURNS `MeetingMutationResult`, NOT `void` (changed by BAL-428), and now THROWS
   * `Meeting not found` when nothing live matches instead of being a silent no-op. Both
   * changes exist for the same reason: deleting a meeting frees a slot, so the caller must
   * learn WHOSE availability to rebuild, and must not be told "done" when nothing happened.
   *
   * ⚠ THE PROJECTION MUST BE STAMPED TOO (BAL-428). `consultations_meeting_uq` is partial
   * on `deleted_at IS NULL`, so leaving the projection live would both keep a deleted
   * meeting occupying the expert's calendar forever AND block re-projecting that meeting id.
   *
   * ⚠ WHY THE CHILDREN MUST BE STAMPED TOO — READ THIS BEFORE "SIMPLIFYING" THE
   * TRANSACTION AWAY. It is NOT (as an earlier draft of this comment claimed) that live
   * orphans would block re-attaching the context to a DIFFERENT meeting: they could not.
   * `meeting_context_unique_idx` is on the TRIPLE `(meeting_id, context_type, context_id)`,
   * so a row left behind on meeting A never conflicts with the same context on meeting B.
   * That reasoning was false; the behaviour is still required, for two REAL reasons:
   *
   *   1. CORRECTNESS OF THE READS. `listByMeeting` and `listMeetingsForContext` filter
   *      `meeting_contexts.deleted_at IS NULL` independently of the parent. Leaving the
   *      children live keeps a soft-deleted meeting's context rows visible — an engagement
   *      would keep reporting a context row pointing at a meeting nobody can load.
   *   2. RE-ATTACHING TO THE **SAME** MEETING WOULD SILENTLY RETURN A STALE ROW. This is
   *      the case the triple index really does block — but it does NOT surface as `23505`
   *      through the seam (an earlier draft of this comment claimed it did). Probed on
   *      Postgres 16: `attach` carries `onConflictDoNothing` with an arbiter matching
   *      `meeting_context_unique_idx`, so the INSERT reports `INSERT 0 0` and returns no
   *      row; `attach`'s follow-up SELECT (filtered `deleted_at IS NULL`) then finds the
   *      live orphan sitting on the soft-deleted meeting and hands THAT back, as though a
   *      fresh attachment had just succeeded. `23505` only escapes from a bare insert with
   *      no arbiter. So the failure is not a loud error the caller can branch on — it is a
   *      resurrected row pointing at a meeting nobody can load.
   */
  async softDelete(id: string): Promise<MeetingMutationResult> {
    return db.transaction(async (tx) => {
      const now = new Date();
      const meeting = await updateLiveMeeting(id, { deletedAt: now }, tx);
      await tx
        .update(meetingContexts)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(meetingContexts.meetingId, id), isNull(meetingContexts.deletedAt)));
      const expertProfileId = await softDeleteProjectionTx(tx, id, now);
      return { meeting, expertProfileId };
    });
  },
};
