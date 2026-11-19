import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { CallRingFacts } from '@balo/shared/meetings';
import { db } from '../client';
import {
  auditEvents,
  engagements,
  meetings,
  meetingContexts,
  meetingRings,
  type Meeting,
  type MeetingRing,
  type MeetingRingPlacement,
  type MeetingRingReach,
  type MeetingRingSide,
} from '../schema';
import type { MeetingCalendarSequenceBump } from './_shared/calendar-sequence';
import { cancelProjectionTx } from './_shared/consultation-projection';
import { createMeetingTx } from './_shared/create-meeting-tx';
import type { DbExecutor } from './_shared/db-executor';
import { endMeetingTx } from './_shared/end-meeting-tx';
import { recordMeetingRingEnded, recordMeetingRingStarted } from './_shared/meeting-audit';
import { applyScheduleMoveTx } from './_shared/schedule-move-tx';
import { isUniqueViolation } from './experts';
import { assertEveryEdgeLegal, END_MEETING_FROM, IN_PROGRESS_FROM } from './meetings';

/** The partial unique index that allows at most one `ringing` ring per case. */
/** The window `countCallerRingsToCallee` looks back over. */
const RING_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;

const ONE_RINGING_PER_ENGAGEMENT_IDX = 'meeting_ring_one_ringing_per_engagement_idx';

/**
 * The meeting statuses the `no_answer` backstop may end FROM: a Call now meeting that never
 * started. Narrower than `END_MEETING_FROM` on purpose — an `in_progress` meeting is a connected
 * call, and ending it as `no_answer` would tear down a live call and strand its session.
 */
const NO_ANSWER_ENDABLE_FROM: ReadonlySet<Meeting['status']> = new Set([
  'scheduled',
  'waiting_for_participants',
]);

/** What every ring start needs. `callerSide` is server-derived, never request input. */
export interface StartRingInput {
  engagementId: string;
  callerUserId: string;
  calleeUserId: string;
  callerSide: MeetingRingSide;
  reachedBy: MeetingRingReach;
  /** When the ring window closes. Must be after the transaction's start (CHECK). */
  expiresAt: Date;
  /** The instant the ring starts, written to `created_at`. Defaults to the database clock. */
  now?: Date;
  /**
   * BAL-651 — the web client's per-tap attempt id, for `call_now_ring_ended` only. `null` when
   * the request carried none or an invalid one. Never an authorization input.
   */
  attemptId: string | null;
  /** BAL-651 — the presence gate's answer at the start, unmasked. Server analytics only. */
  calleeOnlineAtStart: boolean;
}

/** A committed ring start. `expertProfileId` is whose availability to rebuild, if anyone's. */
export interface StartedRing {
  ring: MeetingRing;
  /** The meeting the ring sits on: the one just created, or the booked one it rides. */
  meeting: Meeting;
  /** The created meeting's projected expert on `new_meeting`; `null` on `in_place` (nothing moved). */
  expertProfileId: string | null;
}

/** A committed connect: the ring is `connected` and its meeting started at the connect instant. */
export interface ConnectedRing {
  ring: MeetingRing;
  /** The meeting AFTER the move: `in_progress`, `started_at = scheduled_start = startedAt`. */
  meeting: Meeting;
  /** The window as it was before the connect moved it, read under the same row lock. */
  previous: { scheduledStart: Date; scheduledEnd: Date };
  /** Whose availability cache to rebuild post-commit (the projection moved). */
  expertProfileId: string | null;
  /** Every live calendar row after its SEQUENCE bump — the calendar amend keys on these. */
  calendarEvents: MeetingCalendarSequenceBump[];
  /** The `meeting.rescheduled` row's id — the per-write fan-out idempotency key. */
  rescheduleAuditId: string;
}

/** A committed ring end. */
export interface EndedRing {
  ring: MeetingRing;
  /**
   * The meeting this end terminated as `no_answer`, or `null`: always `null` on `in_place` (the
   * booked meeting is never touched), and `null` on `new_meeting` when the meeting was already
   * terminal.
   */
  endedMeeting: Meeting | null;
  /** Whose availability to rebuild post-commit — set only when `endedMeeting` is. */
  expertProfileId: string | null;
}

/** The three statuses a ring can be ended INTO by `endRing` (connect has its own method). */
export type EndRingStatus = 'unanswered' | 'declined' | 'stopped';

/**
 * Thrown by the two start methods when the case already has a `ringing` ring — a 23505 on
 * `meeting_ring_one_ringing_per_engagement_idx`, and ONLY that index. Every other error is
 * rethrown untouched. On `startWithNewMeeting` the created meeting rolls back with the ring.
 */
export class MeetingRingAlreadyLiveError extends Error {
  constructor(public readonly engagementId: string) {
    super(`Case ${engagementId} already has a ringing Call now ring`);
    this.name = 'MeetingRingAlreadyLiveError';
  }
}

/**
 * Internal control signal: `connect` won the ring's compare-and-set but its meeting could not be
 * started (already `in_progress`, terminal, soft-deleted). Thrown so the ring CAS rolls back with
 * everything else and the method answers `undefined` having changed nothing. Never escapes.
 */
class RingConnectMissSignal extends Error {
  constructor() {
    super('ring meeting not startable');
    this.name = 'RingConnectMissSignal';
  }
}

function toRingConflict(error: unknown, engagementId: string): unknown {
  return isUniqueViolation(error, ONE_RINGING_PER_ENGAGEMENT_IDX)
    ? new MeetingRingAlreadyLiveError(engagementId)
    : error;
}

async function insertRingTx(
  exec: DbExecutor,
  input: StartRingInput & { meetingId: string; placement: MeetingRingPlacement }
): Promise<MeetingRing> {
  const [ring] = await exec
    .insert(meetingRings)
    .values({
      meetingId: input.meetingId,
      engagementId: input.engagementId,
      callerUserId: input.callerUserId,
      calleeUserId: input.calleeUserId,
      callerSide: input.callerSide,
      placement: input.placement,
      reachedBy: input.reachedBy,
      expiresAt: input.expiresAt,
      attemptId: input.attemptId,
      calleeOnlineAtStart: input.calleeOnlineAtStart,
      ...(input.now === undefined ? {} : { createdAt: input.now }),
    })
    .returning();
  if (ring === undefined) {
    throw new Error(`Failed to insert ring for meeting: ${input.meetingId}`);
  }
  return ring;
}

/**
 * End ONE meeting as `no_answer` and release its slot, on `exec`: `endMeetingTx` (presence
 * closed, the terminal CAS, `meeting.ended`), then `cancelProjectionTx` so the expert's
 * availability no longer counts it. `undefined`, having changed nothing, when the meeting was
 * already terminal.
 */
async function endNoAnswerTx(
  exec: DbExecutor,
  input: { meetingId: string; endedAt: Date; actorUserId: string | null }
): Promise<{ meeting: Meeting; expertProfileId: string | null } | undefined> {
  const ended = await endMeetingTx(exec, {
    id: input.meetingId,
    outcome: 'no_answer',
    endedBy: 'system_idle',
    endedAt: input.endedAt,
    actorUserId: input.actorUserId,
    terminalRule: { rule: 'no_answer', arm: null },
  });
  if (ended === undefined) {
    return undefined;
  }
  const expertProfileId = await cancelProjectionTx(exec, input.meetingId);
  return { meeting: ended.meeting, expertProfileId };
}

/** `status = 'ringing'` on a live row — the FROM state of every ring compare-and-set. */
function liveRinging(): SQL | undefined {
  return and(eq(meetingRings.status, 'ringing'), isNull(meetingRings.deletedAt));
}

/**
 * `meetingRingsRepository` (BAL-649) — every Call now ring transition, and the reads behind the
 * gates, the lifecycle sweep and the ring routes.
 *
 * ⚠ EVERY MUTATOR IS ONE TRANSACTION AND WRITES ITS AUDIT ROW LAST (ADR-1030): the ring row, the
 * meeting change and the `meeting.ring_started` / `meeting.ring_ended` row commit or roll back
 * together. Every transition OUT of `ringing` is a compare-and-set on `status = 'ringing'`, so
 * of connect / expiry / decline / stop racing on one ring exactly one wins; the losers answer
 * `undefined` having changed nothing — a normal outcome, never an error.
 *
 * ⚠ LOCK ORDER: every transition OUT of `ringing` takes the RING row first and the meeting after it (`connect`:
 * ring CAS, then the meeting `FOR UPDATE`; `endRing`: ring CAS, then `endMeetingTx`'s presence
 * close and meeting CAS). Connect and expiry racing on one ring therefore queue on the ring row
 * and cannot deadlock. Keep it that way.
 *
 * ⚠⚠ THE CALLER'S POST-COMMIT OBLIGATIONS — `meetingsRepository`'s contract, inherited. This
 * repository cannot reach a queue, Daily or the notification engine
 * (`invariants/repositories-never-notify.test.ts`'s rule), so the caller, after commit:
 *   · enqueues an availability-cache rebuild for every non-null `expertProfileId` returned;
 *   · on `connect`, enqueues the calendar amend for `calendarEvents` (keyed on
 *     `rescheduleAuditId`);
 *   · on an `endedMeeting`, tears the Daily room down and emits `meeting_ended`;
 *   · publishes the ring's domain events.
 */
export const meetingRingsRepository = {
  /**
   * Ring on a NEW `case` meeting, in ONE transaction: `createMeetingTx` (the meeting, its `case`
   * context, its `consultations` projection and `meeting.booked` with the caller as actor), the
   * ring row (`placement = 'new_meeting'` — the meeting's Call now marker), then
   * `meeting.ring_started`.
   *
   * Throws `MeetingRingAlreadyLiveError` when the case already has a ringing ring; the meeting
   * rolls back with it. The projection's expert resolution errors propagate as from
   * `meetingsRepository.create`.
   */
  async startWithNewMeeting(
    input: StartRingInput & { scheduledStart: Date; scheduledEnd: Date }
  ): Promise<StartedRing> {
    try {
      return await db.transaction(async (tx) => {
        const created = await createMeetingTx(tx, {
          scheduledStart: input.scheduledStart,
          scheduledEnd: input.scheduledEnd,
          contexts: [{ contextType: 'case', contextId: input.engagementId }],
          actorUserId: input.callerUserId,
        });
        const ring = await insertRingTx(tx, {
          ...input,
          meetingId: created.meeting.id,
          placement: 'new_meeting',
        });
        await recordMeetingRingStarted(tx, ring);
        return { ring, meeting: created.meeting, expertProfileId: created.expertProfileId };
      });
    } catch (error) {
      throw toRingConflict(error, input.engagementId);
    }
  },

  /**
   * Ring IN PLACE on an existing booked meeting of this case, in ONE transaction: lock the
   * meeting (`FOR UPDATE`) while it is `scheduled`, live, and carries a live `case` context for
   * `engagementId`; insert the ring (`placement = 'in_place'`); write `meeting.ring_started`.
   * The meeting row itself is not written.
   *
   * `undefined`, having changed nothing, when no such meeting exists (wrong case, already
   * started, terminal, soft-deleted). Which booking is eligible (same local day, still ahead) is
   * the caller's rule. Throws `MeetingRingAlreadyLiveError` as `startWithNewMeeting` does.
   */
  async startOnMeeting(
    input: StartRingInput & { meetingId: string }
  ): Promise<StartedRing | undefined> {
    try {
      return await db.transaction(async (tx) => {
        const [meeting] = await tx
          .select()
          .from(meetings)
          .where(
            and(
              eq(meetings.id, input.meetingId),
              eq(meetings.status, 'scheduled'),
              isNull(meetings.deletedAt),
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(meetingContexts)
                  .where(
                    and(
                      eq(meetingContexts.meetingId, meetings.id),
                      eq(meetingContexts.contextType, 'case'),
                      eq(meetingContexts.contextId, input.engagementId),
                      isNull(meetingContexts.deletedAt)
                    )
                  )
              )
            )
          )
          .limit(1)
          .for('update');
        if (meeting === undefined) {
          return undefined;
        }
        const ring = await insertRingTx(tx, { ...input, placement: 'in_place' });
        await recordMeetingRingStarted(tx, ring);
        return { ring, meeting, expertProfileId: null };
      });
    } catch (error) {
      throw toRingConflict(error, input.engagementId);
    }
  },

  /**
   * CONNECT — both parties are present while the ring is `ringing`. ONE transaction:
   *   1. CAS the ring `ringing → connected`, `ended_at = startedAt`. A miss (already ended,
   *      expired by the expiry job, declined, stopped) answers `undefined`.
   *   2. Lock the meeting `FOR UPDATE` and read its window (the pre-image).
   *   3. ONE `UPDATE`: `in_progress`, `started_at = scheduled_start = startedAt`,
   *      `scheduled_end = startedAt + (previous duration)`, FROM `IN_PROGRESS_FROM`. A miss
   *      rolls the ring CAS back too and answers `undefined`.
   *   4. `applyScheduleMoveTx` — projection, guest links (extend-only), calendar SEQUENCE and a
   *      `meeting.rescheduled` row with `reason: 'call_now_connected'` and a NULL actor.
   *   5. `meeting.ring_ended` (`connected`), LAST.
   *
   * The same meeting id, room and join URL are kept: only the window and the status move. No
   * expiry term on the CAS — a callee who joined before the expiry CAS ran connects.
   */
  async connect(input: { ringId: string; startedAt: Date }): Promise<ConnectedRing | undefined> {
    // ⚠ OUTSIDE THE TRANSACTION — pure, and a writer-bug throw must not open one.
    assertEveryEdgeLegal(IN_PROGRESS_FROM, 'in_progress');
    try {
      return await db.transaction(async (tx) => {
        const [ring] = await tx
          .update(meetingRings)
          .set({ status: 'connected', endedAt: input.startedAt, updatedAt: new Date() })
          .where(and(eq(meetingRings.id, input.ringId), liveRinging()))
          .returning();
        if (ring === undefined) {
          return undefined;
        }

        const [previous] = await tx
          .select({ scheduledStart: meetings.scheduledStart, scheduledEnd: meetings.scheduledEnd })
          .from(meetings)
          .where(and(eq(meetings.id, ring.meetingId), isNull(meetings.deletedAt)))
          .limit(1)
          .for('update');
        if (previous === undefined) {
          throw new RingConnectMissSignal();
        }

        const durationMs = previous.scheduledEnd.getTime() - previous.scheduledStart.getTime();
        const [meeting] = await tx
          .update(meetings)
          .set({
            status: 'in_progress',
            startedAt: input.startedAt,
            scheduledStart: input.startedAt,
            scheduledEnd: new Date(input.startedAt.getTime() + durationMs),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(meetings.id, ring.meetingId),
              inArray(meetings.status, [...IN_PROGRESS_FROM]),
              isNull(meetings.deletedAt)
            )
          )
          .returning();
        if (meeting === undefined) {
          throw new RingConnectMissSignal();
        }

        const move = await applyScheduleMoveTx(tx, meeting, previous, {
          actorUserId: null,
          reason: 'call_now_connected',
        });

        await recordMeetingRingEnded(tx, { ring, endedAt: input.startedAt, actorUserId: null });

        return {
          ring,
          meeting,
          previous,
          expertProfileId: move.expertProfileId,
          calendarEvents: move.calendarEvents,
          rescheduleAuditId: move.rescheduleAuditId,
        };
      });
    } catch (error) {
      if (error instanceof RingConnectMissSignal) {
        return undefined;
      }
      throw error;
    }
  },

  /**
   * END a ring that did not connect. ONE transaction:
   *   1. CAS the ring `ringing → to`, `ended_at = now`. For `unanswered` the CAS also requires
   *      `expires_at <= now`, so an expiry job firing early is a no-op. A miss answers
   *      `undefined` (already connected or ended).
   *   2. `new_meeting` only: end the ring's meeting as `no_answer` (`ended_by = 'system_idle'`,
   *      the actor recorded on `meeting.ended`, `terminalRule = no_answer`), closing any open
   *      presence at `now`, and cancel its `consultations` projection so the expert's slot is
   *      released. A meeting that was already terminal is left alone (`endedMeeting = null`).
   *      `in_place` skips this step: the booked meeting is not touched at all.
   *   3. `meeting.ring_ended`, LAST.
   *
   * `actorUserId` is the decliner or stopper, or `null` on expiry.
   */
  async endRing(input: {
    ringId: string;
    to: EndRingStatus;
    now: Date;
    actorUserId: string | null;
  }): Promise<EndedRing | undefined> {
    assertEveryEdgeLegal(END_MEETING_FROM, 'ended');
    return db.transaction(async (tx) => {
      const [ring] = await tx
        .update(meetingRings)
        .set({ status: input.to, endedAt: input.now, updatedAt: new Date() })
        .where(
          and(
            eq(meetingRings.id, input.ringId),
            liveRinging(),
            input.to === 'unanswered' ? lte(meetingRings.expiresAt, input.now) : undefined
          )
        )
        .returning();
      if (ring === undefined) {
        return undefined;
      }

      const ended =
        ring.placement === 'new_meeting'
          ? await endNoAnswerTx(tx, {
              meetingId: ring.meetingId,
              endedAt: input.now,
              actorUserId: input.actorUserId,
            })
          : undefined;

      await recordMeetingRingEnded(tx, {
        ring,
        endedAt: input.now,
        actorUserId: input.actorUserId,
      });

      return {
        ring,
        endedMeeting: ended?.meeting ?? null,
        expertProfileId: ended?.expertProfileId ?? null,
      };
    });
  },

  /**
   * The lifecycle sweep's `no_answer` backstop: end a Call now meeting whose ring is no longer
   * ringing but which never started (`endedAt` is the instant to stamp). Same end shape as
   * `endRing`'s step 2, with a NULL actor, in ONE transaction.
   *
   * ⚠ LOCK ORDER MATCHES `connect`: every ring row of the meeting `FOR UPDATE` first, then the
   * meeting `FOR UPDATE`. A connect racing this either committed first (its ring reads
   * `connected` here and this refuses) or queues behind these locks and then misses its ring CAS.
   *
   * `undefined`, having changed nothing, when:
   *   · it is not a Call now meeting (no live `new_meeting` ring — a booked meeting is never
   *     ended as `no_answer`);
   *   · any of its rings is `ringing` (end that ring through `endRing`, which ends the meeting
   *     with it) or `connected` (the call happened — a connected call is never a `no_answer`);
   *   · the meeting is not `scheduled` or `waiting_for_participants` (started, or already
   *     terminal).
   */
  async endNoAnswerMeeting(input: {
    meetingId: string;
    endedAt: Date;
  }): Promise<{ meeting: Meeting; expertProfileId: string | null } | undefined> {
    assertEveryEdgeLegal(END_MEETING_FROM, 'ended');
    return db.transaction(async (tx) => {
      const rings = await tx
        .select({ placement: meetingRings.placement, status: meetingRings.status })
        .from(meetingRings)
        .where(and(eq(meetingRings.meetingId, input.meetingId), isNull(meetingRings.deletedAt)))
        .orderBy(asc(meetingRings.id))
        .for('update');
      const isCallNowMeeting = rings.some((ring) => ring.placement === 'new_meeting');
      const ringBlocks = rings.some(
        (ring) => ring.status === 'ringing' || ring.status === 'connected'
      );
      if (!isCallNowMeeting || ringBlocks) {
        return undefined;
      }
      const [meeting] = await tx
        .select({ status: meetings.status })
        .from(meetings)
        .where(and(eq(meetings.id, input.meetingId), isNull(meetings.deletedAt)))
        .limit(1)
        .for('update');
      if (meeting === undefined || !NO_ANSWER_ENDABLE_FROM.has(meeting.status)) {
        return undefined;
      }
      return endNoAnswerTx(tx, {
        meetingId: input.meetingId,
        endedAt: input.endedAt,
        actorUserId: null,
      });
    });
  },

  /**
   * ONE live ring by id, ONLY when `userId` is its caller or its callee — the identity check is in
   * the query, so a non-party gets exactly what an unknown id gets: `undefined`.
   */
  async findByIdForParty(
    ringId: string,
    userId: string,
    exec: DbExecutor = db
  ): Promise<MeetingRing | undefined> {
    const [ring] = await exec
      .select()
      .from(meetingRings)
      .where(
        and(
          eq(meetingRings.id, ringId),
          or(eq(meetingRings.callerUserId, userId), eq(meetingRings.calleeUserId, userId)),
          isNull(meetingRings.deletedAt)
        )
      )
      .limit(1);
    return ring;
  },

  /**
   * Has `calleeUserId` declined a ring from `callerUserId` at or after `since`? The Call now
   * decline cooldown. Read from Postgres (the ring rows), never Redis.
   */
  async hasDeclinedSince(
    input: { callerUserId: string; calleeUserId: string; since: Date },
    exec: DbExecutor = db
  ): Promise<boolean> {
    const [row] = await exec
      .select({ id: meetingRings.id })
      .from(meetingRings)
      .where(
        and(
          eq(meetingRings.callerUserId, input.callerUserId),
          eq(meetingRings.calleeUserId, input.calleeUserId),
          eq(meetingRings.status, 'declined'),
          gte(meetingRings.endedAt, input.since),
          isNull(meetingRings.deletedAt)
        )
      )
      .limit(1);
    return row !== undefined;
  },

  /**
   * BAL-651 — how many live rings `callerUserId` placed to `calleeUserId` in the rolling 24 hours
   * ending at `endingAt`: `created_at` in `[endingAt − 24 h, endingAt]`, both ends INCLUSIVE,
   * whatever their status or case. Feeds `call_now_ring_ended.attempt_number_today`, where
   * `endingAt` is the ring's own `created_at`, so the ring counts itself. Rides
   * `meeting_ring_caller_idx`.
   */
  async countCallerRingsToCallee(
    input: { callerUserId: string; calleeUserId: string; endingAt: Date },
    exec: DbExecutor = db
  ): Promise<number> {
    const [row] = await exec
      .select({ value: count() })
      .from(meetingRings)
      .where(
        and(
          eq(meetingRings.callerUserId, input.callerUserId),
          eq(meetingRings.calleeUserId, input.calleeUserId),
          gte(meetingRings.createdAt, new Date(input.endingAt.getTime() - RING_COUNT_WINDOW_MS)),
          lte(meetingRings.createdAt, input.endingAt),
          isNull(meetingRings.deletedAt)
        )
      );
    return row?.value ?? 0;
  },

  /**
   * What happened between a caller and a callee at or after `since`: the missed-call email's
   * recheck. Read from Postgres (the ring rows), never Redis.
   *
   * - `unansweredCount` / `latestUnanswered`: caller → callee rings that ended `unanswered`; the
   *   latest carries its own `engagementId` and `callerSide`, which move together.
   * - `connectedSince`: a ring in EITHER direction that connected, so a call back by the callee
   *   also settles the miss.
   * - `calleeDeclinedSince`: a caller → callee ring the callee declined.
   * - `liveRingBetween`: a ring in EITHER direction still `ringing` with `expiresAt` after `now`,
   *   whatever its age. `now` is an input so the caller owns the clock.
   */
  async summarizeMissedCallWindow(
    input: { callerUserId: string; calleeUserId: string; since: Date; now: Date },
    exec: DbExecutor = db
  ): Promise<{
    unansweredCount: number;
    latestUnanswered: {
      engagementId: string;
      callerSide: MeetingRingSide;
      createdAt: Date;
    } | null;
    connectedSince: boolean;
    calleeDeclinedSince: boolean;
    liveRingBetween: boolean;
  }> {
    const rows = await exec
      .select({
        callerUserId: meetingRings.callerUserId,
        status: meetingRings.status,
        engagementId: meetingRings.engagementId,
        callerSide: meetingRings.callerSide,
        createdAt: meetingRings.createdAt,
      })
      .from(meetingRings)
      .where(
        and(
          or(
            and(
              eq(meetingRings.callerUserId, input.callerUserId),
              eq(meetingRings.calleeUserId, input.calleeUserId)
            ),
            and(
              eq(meetingRings.callerUserId, input.calleeUserId),
              eq(meetingRings.calleeUserId, input.callerUserId)
            )
          ),
          isNull(meetingRings.deletedAt),
          or(
            and(
              inArray(meetingRings.status, ['unanswered', 'connected', 'declined']),
              gte(meetingRings.createdAt, input.since)
            ),
            and(eq(meetingRings.status, 'ringing'), gt(meetingRings.expiresAt, input.now))
          )
        )
      );

    const summary: {
      unansweredCount: number;
      latestUnanswered: {
        engagementId: string;
        callerSide: MeetingRingSide;
        createdAt: Date;
      } | null;
      connectedSince: boolean;
      calleeDeclinedSince: boolean;
      liveRingBetween: boolean;
    } = {
      unansweredCount: 0,
      latestUnanswered: null,
      connectedSince: false,
      calleeDeclinedSince: false,
      liveRingBetween: false,
    };
    for (const row of rows) {
      if (row.status === 'ringing') {
        summary.liveRingBetween = true;
        continue;
      }
      if (row.status === 'connected') {
        summary.connectedSince = true;
        continue;
      }
      if (row.callerUserId !== input.callerUserId) {
        continue;
      }
      if (row.status === 'declined') {
        summary.calleeDeclinedSince = true;
        continue;
      }
      summary.unansweredCount += 1;
      if (
        summary.latestUnanswered === null ||
        row.createdAt.getTime() > summary.latestUnanswered.createdAt.getTime()
      ) {
        summary.latestUnanswered = {
          engagementId: row.engagementId,
          callerSide: row.callerSide,
          createdAt: row.createdAt,
        };
      }
    }
    return summary;
  },

  /**
   * Is any ring `ringing` (expired or not) on ANOTHER live `case` engagement of this company? The
   * `company_in_call` gate: a ringing meeting is still `scheduled`, so the session reads cannot see
   * it, and two members ringing two experts at once would both connect on one wallet.
   */
  async hasRingingOnOtherCompanyCase(
    input: { companyId: string; excludeEngagementId: string },
    exec: DbExecutor = db
  ): Promise<boolean> {
    const [row] = await exec
      .select({ id: meetingRings.id })
      .from(meetingRings)
      .innerJoin(engagements, eq(engagements.id, meetingRings.engagementId))
      .where(
        and(
          liveRinging(),
          ne(meetingRings.engagementId, input.excludeEngagementId),
          eq(engagements.companyId, input.companyId),
          eq(engagements.engagementType, 'case'),
          isNull(engagements.deletedAt)
        )
      )
      .limit(1);
    return row !== undefined;
  },

  /** ONE live ring by id. `undefined` when missing or soft-deleted. */
  async findById(ringId: string, exec: DbExecutor = db): Promise<MeetingRing | undefined> {
    const [ring] = await exec
      .select()
      .from(meetingRings)
      .where(and(eq(meetingRings.id, ringId), isNull(meetingRings.deletedAt)))
      .limit(1);
    return ring;
  },

  /** The meeting's `ringing` ring, expired or not. `undefined` when none rings. */
  async findRingingForMeeting(
    meetingId: string,
    exec: DbExecutor = db
  ): Promise<MeetingRing | undefined> {
    const [ring] = await exec
      .select()
      .from(meetingRings)
      .where(and(eq(meetingRings.meetingId, meetingId), liveRinging()))
      .orderBy(desc(meetingRings.createdAt), desc(meetingRings.id))
      .limit(1);
    return ring;
  },

  /**
   * The newest live ring aimed at `calleeUserId` that is still `ringing` and unexpired at `now`.
   * `undefined` when none.
   */
  async findLiveRingingForCallee(
    calleeUserId: string,
    now: Date,
    exec: DbExecutor = db
  ): Promise<MeetingRing | undefined> {
    const [ring] = await exec
      .select()
      .from(meetingRings)
      .where(
        and(
          eq(meetingRings.calleeUserId, calleeUserId),
          liveRinging(),
          gt(meetingRings.expiresAt, now)
        )
      )
      .orderBy(desc(meetingRings.createdAt), desc(meetingRings.id))
      .limit(1);
    return ring;
  },

  /**
   * The case's `ringing` ring, expired or not — at most one exists
   * (`meeting_ring_one_ringing_per_engagement_idx`). `undefined` when none rings.
   */
  async findRingingForEngagement(
    engagementId: string,
    exec: DbExecutor = db
  ): Promise<MeetingRing | undefined> {
    const [ring] = await exec
      .select()
      .from(meetingRings)
      .where(and(eq(meetingRings.engagementId, engagementId), liveRinging()))
      .limit(1);
    return ring;
  },

  /** Every live ring on a meeting, oldest first — the input to the Call now lifecycle facts. */
  async listForMeeting(meetingId: string, exec: DbExecutor = db): Promise<MeetingRing[]> {
    return exec
      .select()
      .from(meetingRings)
      .where(and(eq(meetingRings.meetingId, meetingId), isNull(meetingRings.deletedAt)))
      .orderBy(asc(meetingRings.createdAt), asc(meetingRings.id));
  },

  /**
   * BAL-651 — the batched twin of `listForMeeting`: every live ring on any of `meetingIds`,
   * reduced to the lifecycle facts and tagged with its meeting, oldest first. Rides
   * `meeting_ring_meeting_idx`. `[]` for an empty input, with no query.
   */
  async listFactsForMeetings(
    meetingIds: string[],
    exec: DbExecutor = db
  ): Promise<Array<CallRingFacts & { meetingId: string }>> {
    if (meetingIds.length === 0) {
      return [];
    }
    return exec
      .select({
        meetingId: meetingRings.meetingId,
        placement: meetingRings.placement,
        status: meetingRings.status,
        createdAt: meetingRings.createdAt,
        expiresAt: meetingRings.expiresAt,
        endedAt: meetingRings.endedAt,
      })
      .from(meetingRings)
      .where(and(inArray(meetingRings.meetingId, meetingIds), isNull(meetingRings.deletedAt)))
      .orderBy(asc(meetingRings.createdAt), asc(meetingRings.id));
  },

  /**
   * BAL-651 — for each meeting a Call now connected IN PLACE of a booking, the start that booking
   * was held for. The ring row does not keep it; the `meeting.rescheduled` audit row the connect
   * wrote (`reason: 'call_now_connected'`) does, as an ISO string in jsonb. The newest such row
   * wins. Meetings with no such ring, or no parsable audit row, are absent. Rides
   * `audit_events_entity_idx`. `[]` for an empty input, with no query.
   */
  async listInPlaceBookedStarts(
    meetingIds: string[],
    exec: DbExecutor = db
  ): Promise<Array<{ meetingId: string; bookedStart: Date }>> {
    if (meetingIds.length === 0) {
      return [];
    }
    const inPlaceMeetings = exec
      .select({ meetingId: meetingRings.meetingId })
      .from(meetingRings)
      .where(
        and(
          inArray(meetingRings.meetingId, meetingIds),
          eq(meetingRings.placement, 'in_place'),
          eq(meetingRings.status, 'connected'),
          isNull(meetingRings.deletedAt)
        )
      );
    const rows = await exec
      .select({
        meetingId: auditEvents.entityId,
        previousScheduledStart: sql<
          string | null
        >`${auditEvents.metadata}->>'previousScheduledStart'`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'meeting'),
          inArray(auditEvents.entityId, inPlaceMeetings),
          eq(auditEvents.action, 'meeting.rescheduled'),
          sql`${auditEvents.metadata}->>'reason' = 'call_now_connected'`
        )
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.seq));

    const newestByMeeting = new Map<string, Date>();
    for (const row of rows) {
      if (newestByMeeting.has(row.meetingId) || row.previousScheduledStart === null) {
        continue;
      }
      const parsed = new Date(row.previousScheduledStart);
      if (!Number.isNaN(parsed.getTime())) {
        newestByMeeting.set(row.meetingId, parsed);
      }
    }
    return [...newestByMeeting].map(([meetingId, bookedStart]) => ({ meetingId, bookedStart }));
  },

  /**
   * `ringing` rings whose window has closed (`expires_at <= now`), soonest-expired first — the
   * sweep's overdue pass. Rides `meeting_ring_ringing_expiry_idx`. ⚠ The CALLER must `log.warn`
   * when the result length equals `limit` (no silent caps). `limit <= 0` answers `[]`.
   */
  async listOverdueRinging(input: { now: Date; limit: number }): Promise<MeetingRing[]> {
    if (input.limit <= 0) {
      return [];
    }
    return db
      .select()
      .from(meetingRings)
      .where(and(liveRinging(), lte(meetingRings.expiresAt, input.now)))
      .orderBy(asc(meetingRings.expiresAt), asc(meetingRings.id))
      .limit(input.limit);
  },
};
