import * as Sentry from '@sentry/node';
import {
  calendarRepository,
  meetingCalendarEventsRepository,
  type MeetingCalendarEvent,
} from '@balo/db';
import type { FastifyBaseLogger } from 'fastify';
import { ApirocError } from '../../lib/apiroc/index.js';
import { isCalendarInviteParty } from '../../notifications/calendar-invite-spec.js';
import { deleteConsultationEvent } from '../consultation-events/index.js';
import { publishCancellationCalendarWithdrawals } from '../calendar-invites/publish-calendar-invites.js';

/**
 * BAL-476 — THE CALENDAR WITHDRAWAL ORCHESTRATOR: what has to happen to a meeting's calendar
 * projection once the meeting has been cancelled.
 *
 * Runs POST-COMMIT, IN-PROCESS, BEST-EFFORT — the same posture as `publishBookingCalendarInvites`,
 * and it is NOT itself a BullMQ job. The cancellation has already committed, so nothing it does
 * may change the status code its caller already earned: every read, every vendor call and every
 * retire is individually caught, logged and swallowed.
 *
 * ⚠ THE ONE AWAIT THAT IS **NOT** WRAPPED IS W1, and that is deliberate rather than an omission.
 * `publishCancellationCalendarWithdrawals` own contract is already "never throws" (each recipient
 * publish is individually try/caught), so a rejection there is a CONTRACT VIOLATION — and the
 * right response to one is to stop BEFORE the retire, leaving the rows LIVE and visible to
 * reconciliation, rather than retiring a projection whose withdrawal was never enqueued. Both
 * producers wrap this call as a backstop for exactly that case.
 *
 * Three steps, in this order:
 *
 * ```
 * W1  publish one meeting.calendar_invite CANCEL per (row × recipient)   ← THE TELLING
 * W2  expert arm: deleteConsultationEvent (marks Balo's row, then events.delete at the vendor)
 * W3  retire every remaining live row for the meeting, PARTY-SCOPED
 * ```
 *
 * ⚠⚠ PUBLISH FIRST, RETIRE SECOND, AND THE ASYMMETRY IS THE WHOLE ARGUMENT — do not "tidy" it:
 *
 * · Crash after W1, before W2/W3 → the CANCELs are enqueued and WILL send (the delivery path's
 *   calendar-row read is retired-tolerant for a CANCEL, so an un-retired row is irrelevant), and
 *   the rows stay live. The delivery path's meeting gate still refuses any later REQUEST for a
 *   `cancelled` meeting, so nothing wrong is sent. Residual: a stale live projection row, visible
 *   to reconciliation. COSMETIC.
 * · The inverted order — retire first, crash before publish → the rows are retired, NO CANCEL is
 *   ever enqueued, and nothing re-drives it. Every recipient keeps a stale calendar entry
 *   FOREVER. That is the exact defect this ticket exists to close.
 *
 * ⚠⚠ ORDERING ALONE ONLY COVERS **PROCESS DEATH**, AND AN EARLIER VERSION OF THIS BLOCK STOPPED
 * THERE — WHICH WAS AN OVERCLAIM. Every publish in W1 is individually try/caught (`publishOne`
 * swallows an enqueue failure; `resolveRowRecipients` swallows a read failure), so on a Redis or
 * DB blip the process does NOT die: W1 returns normally having enqueued nothing, and W3 then
 * retired every row anyway — reaching the permanent failure the ordering exists to prevent, by a
 * path the ordering never touched. **W1 therefore REPORTS which rows it fully discharged, and W3
 * retires only those.** A row whose recipients could not be read, or any of whose publishes was
 * refused, STAYS LIVE — the cosmetic, reconciliation-visible residual, which is the correct
 * direction.
 *
 * ⚠⚠ THE ONE ROW THAT CANNOT BE HELD BACK IS THE EXPERT-PARTY `provider_event` ROW, AND IT IS A
 * DOCUMENTED RESIDUAL RATHER THAN AN OVERSIGHT. W2's `deleteConsultationEvent` marks Balo's row
 * deleted BEFORE it calls the vendor (its own deliberate mark-first ordering, which this file
 * does not reorder), so that row is retired inside W2 whatever W1 reported. The alternative —
 * gating W2 on that row's CANCELs having enqueued — was considered and REJECTED: the recipients
 * of an expert-party `provider_event` row are that side's admitted GUESTS only (Ruling 1 excludes
 * the expert member), so gating would mean a Redis blip leaves the EXPERT'S OWN calendar entry
 * sitting on a cancelled meeting. That is worse for the primary user than the residual it buys,
 * which is an expert-side GUEST keeping a stale entry.
 *
 * ⚠ BUT THE TWO RESIDUALS ARE **NOT EQUALLY RECOVERABLE**, and an earlier version of this note
 * flattened them together by calling both "equally visible to reconciliation". They are not:
 *
 *   · A HELD-BACK ROW (client party, or an expert `ics` row) stays LIVE. It is visible to any
 *     reconciliation that walks `meeting_calendar_events` against cancelled meetings — which is
 *     the whole reason the hold-back exists.
 *   · THE EXPERT `provider_event` ROW IS ALREADY RETIRED by the time anything could notice, so
 *     that walk will never surface it. The only remaining evidence that a guest is owed a CANCEL
 *     is the `meeting_calendar_deliveries` ledger — no `sent` row at that `(calendarEventId,
 *     recipient, sequence, method)` — which is a different query nothing runs today.
 *
 * The trade-off still stands; the recoverability does not, and a future sweep has to be written
 * against the ledger rather than the projection to catch this arm.
 *
 * ⚠ An expert-party `ics` row is NOT affected: W2 never touches it, so the hold-back applies to
 * it normally and it lands in the recoverable case above.
 *
 * A mid-loop crash inside W1 leaves some recipients enqueued and others not; nothing re-drives
 * it. Accepted — identical to every other publisher in `publish-calendar-invites.ts`, whose
 * contract is already "never throws, post-commit, best-effort". Once a CANCEL job IS enqueued,
 * retry safety is the shipped `claimSend` protocol: the same job id re-claims, a `sent` row is
 * never re-claimed.
 *
 * ⚠ THE VENDOR DELETE STAYS INLINE AND BEST-EFFORT — NO NEW BullMQ JOB, and the reason is
 * mechanical rather than stylistic. `deleteConsultationEvent` re-reads `findLiveExpertProviderEvent`
 * first; on a second attempt the row is already soft-deleted, so it returns `undefined` and
 * SILENTLY PERFORMS NO VENDOR DELETE. A retry around a mark-first function is a no-op, not a
 * retry. That same property is what gives the AC's idempotency requirement for free: a second
 * withdrawal for one meeting finds no live provider row, returns, and touches the vendor zero
 * times.
 */

export interface WithdrawMeetingCalendarInput {
  readonly meetingId: string;
  /**
   * THE PER-WRITE CORRELATION HANDLE — the `meeting.cancelled` audit row id, on BOTH producers.
   * ⚠ NEVER `meeting_calendar_events.id`, which is stable across reschedules and guest-adds and
   * would be swallowed inside BullMQ's retained-completed window.
   */
  readonly cancelAuditId: string;
  /** Whose connection can address the vendor event. `null` ⇒ no vendor arm (the rows still retire). */
  readonly expertProfileId: string | null;
}

/** The `{ errorName, error, stack }` triple every `log.error` below shares. */
function toErrorLogFields(error: unknown): {
  errorName: string;
  error: string;
  stack: string | undefined;
} {
  return {
    errorName: error instanceof Error ? error.name : 'unknown',
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/**
 * W2 — the vendor arm. Only reached when the meeting has an expert-party `provider_event` row.
 *
 * ⚠ A `not_found` FROM THE VENDOR IS AN EXPLICIT SUCCESS, logged at `info`, mirroring
 * `deleteRoom`'s 404 handling for the identical reason: the caller's goal ("the event is not on
 * that calendar any more") is satisfied either way, and the AC's "no vendor delete error on an
 * already-deleted event" is then satisfied LITERALLY rather than by accident.
 */
async function deleteVendorEventBestEffort(
  input: {
    readonly meetingId: string;
    readonly expertProfileId: string | null;
    readonly row: MeetingCalendarEvent;
  },
  log: FastifyBaseLogger
): Promise<void> {
  const { meetingId, expertProfileId, row } = input;
  if (expertProfileId === null) {
    log.warn(
      { meetingId },
      'Calendar withdrawal cannot address the vendor event — the cancellation named no expertProfileId; the row is still retired'
    );
    return;
  }

  let endUserAccountId: string;
  try {
    // ⚠ THE SAME RESOLUTION `jobs/meeting-calendar-amend.ts` uses, and for the reason its comment
    // gives: `calendarRepository` exposes NO "get connection by id" read.
    const connections = await calendarRepository.listConnectionsByExpertProfileId(expertProfileId);
    const connection = connections.find((candidate) => candidate.id === row.connectionId);
    if (connection === undefined) {
      log.warn(
        { meetingId, expertProfileId, connectionId: row.connectionId },
        'Calendar withdrawal — the stored connection no longer exists; skipping the vendor delete'
      );
      return;
    }
    endUserAccountId = connection.endUserAccountId;
  } catch (error) {
    const fields = { meetingId, expertProfileId, ...toErrorLogFields(error) };
    log.error(fields, 'Calendar withdrawal could not read the expert calendar connections');
    Sentry.captureException(error, { extra: fields });
    return;
  }

  try {
    await deleteConsultationEvent({ meetingId, endUserAccountId });
  } catch (error) {
    if (error instanceof ApirocError && error.kind === 'not_found') {
      log.info({ meetingId }, 'Vendor calendar event already gone — treating the delete as done');
      return;
    }
    const fields = { meetingId, ...toErrorLogFields(error) };
    log.error(
      fields,
      "Apiroc event delete failed after a cancellation — Balo's row is retired; the vendor event is orphaned but still tagged with balo_booking_id and reconcilable by tag"
    );
    Sentry.captureException(error, { extra: fields });
  }
}

/**
 * Withdraw a cancelled meeting's whole calendar projection.
 *
 * ⚠ IT THROWS FOR EXACTLY ONE THING: a contract violation inside W1. See the module docblock.
 */
export async function withdrawMeetingCalendarProjection(
  input: WithdrawMeetingCalendarInput,
  log: FastifyBaseLogger
): Promise<void> {
  const { meetingId, cancelAuditId, expertProfileId } = input;

  // W0 — ONE snapshot, shared by the publish and the retire.
  let rows: MeetingCalendarEvent[];
  try {
    rows = await meetingCalendarEventsRepository.listLiveByMeeting(meetingId);
  } catch (error) {
    const fields = { meetingId, cancelAuditId, ...toErrorLogFields(error) };
    log.error(fields, 'Calendar withdrawal could not read the meeting calendar rows');
    Sentry.captureException(error, { extra: fields });
    return;
  }
  if (rows.length === 0) {
    log.info({ meetingId, cancelAuditId }, 'Calendar withdrawal — no calendar row to withdraw');
    return;
  }
  log.info({ meetingId, cancelAuditId, rowCount: rows.length }, 'Calendar withdrawal started');

  // W1 — THE TELLING FIRST. Never throws (every recipient publish is individually try/caught) —
  // which is exactly why it has to REPORT: a swallowed failure is invisible otherwise. The
  // returned set is the row ids whose withdrawal is fully enqueued (or that had nobody to tell).
  const discharged = await publishCancellationCalendarWithdrawals(
    { meetingId, cancelAuditId, expertProfileId, calendarEvents: rows },
    log
  );

  // W2 — the vendor arm, for the expert-party PROVIDER row only.
  const providerRow = rows.find(
    (row) => row.party === 'expert' && row.deliveryMode === 'provider_event'
  );
  if (providerRow !== undefined) {
    await deleteVendorEventBestEffort({ meetingId, expertProfileId, row: providerRow }, log);
  }

  // W3 — RETIRE, PARTY-SCOPED, ONE CALL PER ROW WITH THAT ROW'S OWN PARTY.
  //
  // ⚠⚠ NEVER A WHOLE-MEETING SOFT DELETE. `softDeleteByMeetingAndParty`'s own docblock states
  // the rationale: a client-party row must not be collateral for something that happened on the
  // expert's calendar. This loop is what closes the shipped gap where nothing retired the CLIENT
  // party's `ics` row on a cancellation.
  //
  // ⚠ The expert provider row was already retired inside W2 (`deleteConsultationEvent` marks
  // first), so its call here matches zero rows — idempotent by the `deleted_at IS NULL` predicate.
  // That is also why the hold-back below cannot protect THAT row; see the module docblock's
  // residual note.
  //
  // ⚠⚠ ONLY THE ROWS W1 SAID IT DISCHARGED. A row whose CANCELs were not all enqueued stays LIVE
  // on purpose: retiring it would remove the only evidence that anybody is owed a withdrawal.
  for (const row of rows) {
    if (!discharged.has(row.id)) {
      log.warn(
        { meetingId, cancelAuditId, calendarEventId: row.id, party: row.party },
        'Leaving the calendar row LIVE — its withdrawal was not fully enqueued, so retiring it would hide a stale projection from reconciliation'
      );
      continue;
    }
    if (!isCalendarInviteParty(row.party)) {
      // Unreachable under `meeting_calendar_event_party_two_sided`; a database that disagrees
      // with its own CHECK must not be soft-deleted from on a party the column cannot hold.
      log.error(
        { meetingId, cancelAuditId, calendarEventId: row.id, party: row.party },
        'meeting_calendar_events row holds a party the two-sided CHECK forbids — not retiring it'
      );
      continue;
    }
    const party = row.party;
    try {
      await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(meetingId, party);
    } catch (error) {
      log.error(
        { meetingId, cancelAuditId, party: row.party, ...toErrorLogFields(error) },
        'Failed to retire the calendar row after a withdrawal'
      );
    }
  }
}
