import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  meetingCalendarEvents,
  type MeetingCalendarDeliveryMode,
  type MeetingParticipantParty,
} from '../../schema';
import type { MeetingCalendarEventParty } from '../meeting-calendar-events';
import type { DbExecutor } from './db-executor';

/** One live calendar row for a meeting, AFTER its SEQUENCE bump. */
export interface MeetingCalendarSequenceBump {
  readonly id: string;
  readonly party: MeetingCalendarEventParty;
  readonly deliveryMode: MeetingCalendarDeliveryMode;
  /** The POST-bump value — the SEQUENCE the re-sent ICS must carry. */
  readonly sequence: number;
}

/**
 * Narrow the reused three-label party enum to the two sides a calendar row may hold. The
 * CHECK `meeting_calendar_event_party_two_sided` makes the `false` arm unreachable; this is a
 * type guard (never an `as`) so the narrowed type is earned.
 *
 * ⚠ F12 (fix round 1, R11) — A THIRD, INDEPENDENT DECLARATION OF THIS SAME TWO-VS-THREE-LABEL
 * GUARD (alongside `apps/api/src/notifications/calendar-invite-spec.ts`'s
 * `isCalendarInviteParty` and the narrowing in
 * `apps/api/src/services/calendar-invites/publish-calendar-invites.ts`), and it stays that way
 * DELIBERATELY: `packages/db` cannot import from `apps/api`, and `MeetingParticipantParty` /
 * `MeetingCalendarEventParty` are themselves `packages/db` schema types with no natural home in
 * `@balo/shared` (moving them there would pull Drizzle's inferred row shapes across the
 * package boundary the client-bundle footgun exists to prevent). A shared implementation would
 * need a fourth package or a `@balo/shared` copy of a `packages/db`-only type — worse than one
 * more three-line predicate.
 */
function isCalendarEventParty(party: MeetingParticipantParty): party is MeetingCalendarEventParty {
  return party === 'client' || party === 'expert';
}

/** Client before expert — a stable order for callers and tests; at most one row per party. */
const PARTY_ORDER: Readonly<Record<MeetingCalendarEventParty, number>> = { client: 0, expert: 1 };

/**
 * BAL-475 — THE ONLY WRITER OF `meeting_calendar_events.sequence`.
 *
 * Increments the RFC 5545 SEQUENCE of every LIVE calendar row of one meeting by exactly 1 and
 * returns the post-bump rows (client first, then expert).
 *
 * ⚠ CALLED ONLY INSIDE `meetingsRepository.updateSchedule`'s TRANSACTION (step 4b), under that
 * transaction's `FOR UPDATE` lock on the meeting row. So the bump commits or rolls back WITH
 * the move, two concurrent moves serialise and each bumps exactly once, and a rolled-back move
 * bumps nothing. No BullMQ job, publisher or delivery path writes `sequence` — which is what
 * makes "no double increment on a retry" structural rather than a convention.
 *
 * ⚠ A GUEST-ADD DOES NOT BUMP (decision U4): no ICS lists other people, so existing recipients'
 * copies are unchanged; the new guest receives the side's CURRENT sequence.
 *
 * Soft-deleted rows are untouched (a retired series is never re-sent). A meeting with no live
 * rows answers `[]`.
 *
 * A `_shared/` internal, deliberately NOT barrel-exported (the `_shared/guest-expiry.ts`
 * precedent); only the {@link MeetingCalendarSequenceBump} TYPE crosses the package boundary.
 */
export async function bumpCalendarSequencesForMeetingTx(
  exec: DbExecutor,
  meetingId: string
): Promise<MeetingCalendarSequenceBump[]> {
  const rows = await exec
    .update(meetingCalendarEvents)
    .set({
      sequence: sql`${meetingCalendarEvents.sequence} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(meetingCalendarEvents.meetingId, meetingId), isNull(meetingCalendarEvents.deletedAt))
    )
    .returning({
      id: meetingCalendarEvents.id,
      party: meetingCalendarEvents.party,
      deliveryMode: meetingCalendarEvents.deliveryMode,
      sequence: meetingCalendarEvents.sequence,
    });

  const bumps: MeetingCalendarSequenceBump[] = [];
  for (const row of rows) {
    const { party } = row;
    if (!isCalendarEventParty(party)) {
      // Unreachable under `meeting_calendar_event_party_two_sided`. Throwing rolls the whole
      // move back — a database that disagrees with its own CHECK must not be re-sent from.
      throw new Error(
        `meeting_calendar_events row ${row.id} holds party '${party}', which the two-sided CHECK forbids`
      );
    }
    bumps.push({ id: row.id, party, deliveryMode: row.deliveryMode, sequence: row.sequence });
  }
  return bumps.sort((a, b) => PARTY_ORDER[a.party] - PARTY_ORDER[b.party]);
}
