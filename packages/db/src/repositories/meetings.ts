import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  meetings,
  meetingContexts,
  type Meeting,
  type MeetingContext,
  type MeetingContextType,
  type NewMeeting,
} from '../schema';

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
 */
async function updateLiveMeeting(id: string, set: Partial<NewMeeting>): Promise<Meeting> {
  const [updated] = await db
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
 * ⚠ DELIBERATELY NO STATUS MUTATOR. `start()` / `end()` / the transition map are
 * **BAL-134's**, so the state machine is defined in exactly ONE place. Tests drive
 * non-`scheduled` states through `meetingFactory`'s `values` override (the
 * `transcript.factory` precedent), never through a repository method that would become a
 * second, competing definition of the lifecycle.
 */
export const meetingsRepository = {
  /**
   * Insert the meeting AND its context rows in ONE transaction — a meeting can never
   * exist without a context, even transiently. Throws `MeetingContextRequiredError` on an
   * empty `contexts` array (before any write).
   *
   * `scheduledStart < scheduledEnd` is re-asserted in-process, MIRRORING `updateSchedule`,
   * so the SAME invariant surfaces as the SAME typed error from BOTH entry points rather
   * than a raw `23514` from one and a named error from the other. The CHECK
   * `meeting_scheduled_start_before_end` remains the backstop.
   */
  async create(input: CreateMeetingInput): Promise<MeetingWithContexts> {
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

      return { meeting, contexts };
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
   * BAL-409 RESCHEDULE SEAM. Re-asserts `start < end` in-process so the caller gets a
   * named error rather than a raw `23514` from `meeting_scheduled_start_before_end`
   * (which remains the backstop).
   */
  async updateSchedule(
    id: string,
    schedule: { scheduledStart: Date; scheduledEnd: Date }
  ): Promise<Meeting> {
    assertScheduleOrder(schedule.scheduledStart, schedule.scheduledEnd);

    return updateLiveMeeting(id, {
      scheduledStart: schedule.scheduledStart,
      scheduledEnd: schedule.scheduledEnd,
    });
  },

  /**
   * Soft-delete a meeting AND its context rows in ONE transaction.
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
   *   2. RE-ATTACHING TO THE **SAME** MEETING. This is the case the triple index really
   *      does block: with the child left live, re-attaching that exact context to that
   *      exact meeting raises `23505`.
   */
  async softDelete(id: string): Promise<void> {
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(meetings)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)));
      await tx
        .update(meetingContexts)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(meetingContexts.meetingId, id), isNull(meetingContexts.deletedAt)));
    });
  },
};
