import { auditEventsRepository } from '../audit-events';
import type { MeetingContextType } from '../../schema';
import type { DbExecutor } from './db-executor';

/**
 * The meeting audit vocabulary (BAL-129 / ADR-1044 §5). `audit_events` (BAL-344) stores
 * `action`/`entityType` as open `text`, so this union keeps OUR emitted taxonomy typo-safe at
 * compile time WITHOUT the generic repo needing to know it. Mirrors
 * `_shared/schedule-audit.ts`.
 *
 * ⚠ TWO OF THE FOUR HAVE WRITERS: `meeting.booked` (BAL-129, on `create`) and `meeting.ended`
 * (BAL-134, on `endMeeting`). The other two are RESERVED — declared here so their eventual
 * writers inherit THIS vocabulary rather than minting a near-miss spelling
 * (`meeting.reschedule`, `meeting.canceled`) that no "history of one meeting" read would ever
 * find. `audit_events.action` is open TEXT, so a reserved label costs no migration and no enum
 * value:
 *   · `meeting.rescheduled` — owner BAL-409/BAL-411, on `meetingsRepository.updateSchedule`.
 *   · `meeting.cancelled`   — owner BAL-410, on `meetingsRepository.cancel`.
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
 * Both reserved mutators exist and are unaudited today, which is safe only because NEITHER HAS
 * A PRODUCTION CALLER (`repositories/meetings.ts`) — so neither can yet produce an
 * unattributed, party-visible state change. Wiring a caller without also wiring its audit row
 * re-opens exactly the ADR-1044 §5 gap BAL-129 closes here.
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
): Promise<void> {
  const entityType: MeetingAuditEntityType = 'meeting';

  await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType,
      entityId: input.meetingId,
      metadata: input.metadata ?? null,
    },
    exec
  );
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
