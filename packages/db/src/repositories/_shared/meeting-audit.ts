import { auditEventsRepository } from '../audit-events';
import type { MeetingContextType } from '../../schema';
import type { DbExecutor } from './db-executor';

/**
 * The meeting audit vocabulary (BAL-129 / ADR-1044 §5). `audit_events` (BAL-344) stores
 * `action`/`entityType` as open `text`, so this union keeps OUR emitted taxonomy typo-safe at
 * compile time WITHOUT the generic repo needing to know it. Mirrors
 * `_shared/schedule-audit.ts`.
 *
 * ⚠ ALL FOUR NOW HAVE WRITERS, AS OF BAL-410: `meeting.booked` (BAL-129, on `create`),
 * `meeting.ended` (BAL-134, on `endMeeting`), `meeting.rescheduled` (BAL-409, on
 * `meetingsRepository.updateSchedule`, via `recordMeetingRescheduled` below) and — new here —
 * `meeting.cancelled` (BAL-410, on `meetingsRepository.cancel`, via `recordMeetingCancelled`).
 * The label was RESERVED ahead of its writer precisely so that writer would inherit THIS
 * vocabulary rather than mint a near-miss spelling (`meeting.canceled`) that no "history of one
 * meeting" read would ever find; that worked, and the reservation is now discharged.
 * `audit_events.action` is open TEXT, so neither the reservation nor its writer cost a migration
 * or an enum value.
 *
 * ⚠ `meeting.ended` IS WRITTEN WITH A NULL ACTOR ON FOUR OF THE FIVE TERMINAL PATHS, and that
 * is the ADR-1030 system-actor exemption, not a miss: idle end, no-show, missed call and
 * abandoned wait are all decided by the lifecycle sweep, where there genuinely is no human to
 * name. Its `metadata.endedBy` carries WHICH kind of ender it was in every case, so a null
 * `actor_user_id` beside `endedBy: 'system_idle'` is a complete record, while a null beside
 * `'client_principal'` or `'expert_host'` would be a bug — the human paths always pass the
 * acting user.
 *
 * ⚠ A RESERVED ACTION IS NOT THE SAME LIE AS AN UNWRITTEN COLUMN, and the distinction is worth
 * stating because `schema/meeting-presence.ts` rules the other way for columns: "an attribution
 * column with no writer is a worse lie than its absence". A column materialises a NULL on EVERY
 * row, which a downstream reader consumes as fact ("nobody booked this"). An unwritten union
 * member materialises NOTHING — zero rows carry it, so no reader can be misled by it; it is
 * visible only to someone reading this file. That is why the reserved labels ship and an
 * attribution column on `meetings` does not (see `meetingsRepository.create`).
 *
 * ⚠ AND THAT ARGUMENT IS WHY BAL-410 ADDED **NO** `cancelled_by_user_id` COLUMN AND NO MIGRATION
 * (orchestrator D8). Every read path that could have forced one was checked and none needs
 * cancelled-by: the consultation row renders a lens-independent "Cancelled — nothing charged"
 * naming nobody, `deriveCaseConsultationState` reads `meetings.status` alone, and the
 * `booking.cancelled` notification resolves the actor label IN-PROCESS from the `actorUserId`
 * the route already holds. An admin "who cancelled this" screen, if one is ever built, joins
 * `audit_events` on `(entity_type='meeting', entity_id, action='meeting.cancelled')`.
 *
 * ⚠ `cancel` USED TO BE UNAUDITED, which was safe only while it had no production caller. It has
 * one now (`POST /meetings/:meetingId/cancel`), and `recordMeetingCancelled` below is what keeps
 * that from re-opening the ADR-1044 §5 gap BAL-129 closes here: a party-visible state change
 * that names no actor.
 */
export type MeetingAuditAction =
  | 'meeting.booked'
  | 'meeting.rescheduled'
  | 'meeting.cancelled'
  | 'meeting.ended'
  /**
   * BAL-412 — settlement resolved `meetings.outcome` from `meeting_presence` on a meeting
   * BAL-134 deliberately left NULL (the two human-end paths and the abandoned wait; ADR-1049
   * "the ender never sets the outcome"). Written by `meetingsRepository.setOutcomeIfUnset`,
   * on the settlement transaction, and ONLY when the write actually happened — a no-op
   * (outcome already resolved, meeting not `ended`, row soft-deleted) writes NOTHING, so an
   * audit row here always attests to a real state change.
   *
   * ⚠ THE THIRD MEMBER WITH A WRITER, and — like `meeting.ended` — it is written with a NULL
   * actor on the SYSTEM path (the lifecycle sweep's terminations) and with the acting human
   * on the End-button path. Same ADR-1030 system-actor exemption, same reading.
   */
  | 'meeting.outcome_resolved';

/** Subject of a meeting audit row is always the meeting (entity_id = `meetings.id`). */
export type MeetingAuditEntityType = 'meeting';

/**
 * Record ONE meeting audit event inside the caller's transaction (pass the `tx` handle — it
 * satisfies `DbExecutor`), so the audit row commits or rolls back WITH the state change it
 * records (ADR-1030, reasserted by ADR-1044 §5). The entity is the `meetings` row.
 */
export async function recordMeetingAudit(
  exec: DbExecutor,
  input: {
    actorUserId: string | null;
    action: MeetingAuditAction;
    meetingId: string;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const entityType: MeetingAuditEntityType = 'meeting';

  const row = await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType,
      entityId: input.meetingId,
      metadata: input.metadata ?? null,
    },
    exec
  );

  // ⚠ RETURNS THE AUDIT ROW ID, and that is load-bearing for reschedule — not a convenience.
  // `audit_events` is append-only, so this id is UNIQUE PER WRITE. Reschedule's outbound
  // fan-out keys its BullMQ jobIds off it precisely because every window-derived key
  // COLLIDES on a move BACK to a previously-used window (A→B→C→B), and BullMQ silently
  // no-ops an `add` whose jobId already exists in the retained completed set. Existing
  // callers may ignore the return; nothing else about the write changed.
  return row.id;
}

/**
 * Record the `meeting.booked` row for ONE booking, inside `meetingsRepository.create`'s
 * transaction. THE ONLY SHIPPED WRITER on this vocabulary.
 *
 * Defined here rather than inlined in `create` so the METADATA SHAPE lives beside the action
 * union it belongs to: the reserved reschedule/cancel writers must emit the same keys for a
 * "history of one meeting" read to line up, and a shape assembled at each call site is exactly
 * how `contextType` becomes `context_type` on the second writer.
 *
 * `actorUserId` is REQUIRED but NULLABLE — pass the human who booked, or `null` when the path
 * genuinely has none. `null` is the ADR-1030 SYSTEM-ACTOR ATTRIBUTION EXEMPTION, the same
 * convention `recordEngagementCreated` and `actionItemsRepository.createFromExtraction` use:
 * an unattributed row, never a fabricated actor. The dev seeder is the one live caller that
 * takes it (`services/seed/seed-service.ts`).
 *
 * ⚠ THE WINDOW IS STORED AS ISO STRINGS, NOT `Date`. `metadata` is `jsonb`, so a `Date` written
 * into it round-trips as a string: typing the stored shape as `Date` would be a lie on the way
 * back out. The conversion happens HERE, once, rather than at each future call site.
 *
 * ⚠ `expertProfileId` IS IN THE METADATA ON PURPOSE — it is WHOSE CALENDAR THIS BOOKING BLOCKED,
 * resolved at write time from the contexts by `projectNewMeetingTx` and therefore NOT re-derivable
 * later (a context edit would resolve a different expert). `null` is an admin meeting, which
 * blocks nobody. Without it the audit row records that a booking happened but not what it cost
 * anyone.
 */
export async function recordMeetingBooked(
  exec: DbExecutor,
  input: {
    meetingId: string;
    actorUserId: string | null;
    contexts: ReadonlyArray<{ contextType: MeetingContextType; contextId: string | null }>;
    scheduledStart: Date;
    scheduledEnd: Date;
    expertProfileId: string | null;
  }
): Promise<void> {
  await recordMeetingAudit(exec, {
    actorUserId: input.actorUserId,
    action: 'meeting.booked',
    meetingId: input.meetingId,
    metadata: {
      // Mapped rather than passed through: the caller's `MeetingContextInput[]` is the WRITE
      // input type, and storing it whole would silently persist any field later added to it.
      contexts: input.contexts.map((context) => ({
        contextType: context.contextType,
        contextId: context.contextId,
      })),
      scheduledStart: input.scheduledStart.toISOString(),
      scheduledEnd: input.scheduledEnd.toISOString(),
      expertProfileId: input.expertProfileId,
    },
  });
}

/**
 * Record the `meeting.rescheduled` row for ONE move, inside `meetingsRepository.updateSchedule`'s
 * transaction. BAL-409 — the first shipped writer on this reserved label (BAL-411 shares it for
 * the expert-initiated half).
 *
 * ⚠ THE WINDOW IS STORED AS ISO STRINGS, NOT `Date` — same rule as `recordMeetingBooked`.
 * `metadata` is `jsonb`, so a `Date` written into it round-trips as a string; typing the stored
 * shape as `Date` would be a lie on the way back out.
 *
 * `previous` is the pre-image read inside the SAME transaction (before the compare-and-set), so
 * a "history of one meeting" read can show the from/to window without a second query.
 */
export async function recordMeetingRescheduled(
  exec: DbExecutor,
  input: {
    meetingId: string;
    actorUserId: string | null;
    previous: { scheduledStart: Date; scheduledEnd: Date };
    scheduledStart: Date;
    scheduledEnd: Date;
    expertProfileId: string | null;
    guestLinksExtended: number;
  }
): Promise<string> {
  return recordMeetingAudit(exec, {
    actorUserId: input.actorUserId,
    action: 'meeting.rescheduled',
    meetingId: input.meetingId,
    metadata: {
      previousScheduledStart: input.previous.scheduledStart.toISOString(),
      previousScheduledEnd: input.previous.scheduledEnd.toISOString(),
      scheduledStart: input.scheduledStart.toISOString(),
      scheduledEnd: input.scheduledEnd.toISOString(),
      expertProfileId: input.expertProfileId,
      guestLinksExtended: input.guestLinksExtended,
    },
  });
}

/**
 * Record the `meeting.cancelled` row for ONE cancellation, inside `meetingsRepository.cancel`'s
 * transaction. BAL-410 — the LAST of the four reserved labels to gain a writer.
 *
 * ⚠ THE ACTION LITERAL IS `'meeting.cancelled'`, NEVER `'meeting.canceled'`. That single-`l`
 * near-miss is the exact failure the reservation at the top of this file exists to prevent: a
 * "history of one meeting" read filters on the label, so a misspelling is not a typo, it is a
 * row nobody will ever find again.
 *
 * ⚠ THE WINDOW IS STORED AS ISO STRINGS, NOT `Date` — the same rule `recordMeetingBooked` and
 * `recordMeetingRescheduled` state. `metadata` is `jsonb`, so a `Date` written into it round-
 * trips as a string; typing the stored shape as `Date` would be a lie on the way back out.
 *
 * ⚠ `expertProfileId` IS WHOSE CALENDAR THIS CANCELLATION FREED, resolved inside the same
 * transaction by `cancelProjectionTx` from the LIVE projection row — never re-derived later,
 * because a context edit would resolve a different expert. `null` is an admin meeting, which
 * frees nobody's calendar.
 *
 * `actorUserId` is REQUIRED but NULLABLE. `null` is the ADR-1030 SYSTEM-ACTOR ATTRIBUTION
 * EXEMPTION — an unattributed row, never a fabricated actor — and the dev seeder
 * (`services/seed/seed-service.ts`) is its one live caller, paired with `actorRole: 'system'`.
 * Every human path passes the acting user AND the arm that authorized them, so the pair
 * `(actorUserId: null, actorRole: 'system')` is a complete record and
 * `(null, 'client'|'expert'|'admin')` would be a bug.
 *
 * ⚠ RETURNS THE AUDIT ROW ID, and — exactly as for reschedule — that is LOAD-BEARING rather
 * than a convenience. `audit_events` is append-only, so the id is UNIQUE PER SUCCESSFUL CANCEL,
 * and the post-commit fan-out keys its BullMQ jobId off it. A `meetingId`-derived key would be
 * unique per MEETING, not per WRITE, and BullMQ silently no-ops an `add` whose jobId is already
 * in the retained completed set.
 */
export async function recordMeetingCancelled(
  exec: DbExecutor,
  input: {
    meetingId: string;
    actorUserId: string | null;
    actorRole: 'client' | 'expert' | 'admin' | 'system';
    scheduledStart: Date;
    scheduledEnd: Date;
    expertProfileId: string | null;
  }
): Promise<string> {
  return recordMeetingAudit(exec, {
    actorUserId: input.actorUserId,
    action: 'meeting.cancelled',
    meetingId: input.meetingId,
    metadata: {
      // WHICH AUTHORIZATION ARM matched — server-derived, never taken from the wire.
      actorRole: input.actorRole,
      scheduledStart: input.scheduledStart.toISOString(),
      scheduledEnd: input.scheduledEnd.toISOString(),
      expertProfileId: input.expertProfileId,
    },
  });
}
