import {
  calendarInviteRecipientKey,
  type CalendarInviteParty,
  type CalendarInviteRecipient,
} from '../../notifications/calendar-invite-spec.js';

/**
 * BAL-475 (O2) — the per-write correlation key for one recipient of one calendar-invite send.
 *
 * ⚠ PER WRITE, NEVER PER STATE (`reference_bullmq_jobid_must_be_per_write_not_per_state`).
 * ⚠ MUST INCLUDE THE RECIPIENT: the publisher's jobId is `buildJobId('meeting.calendar_invite',
 * correlationId)` — it has no recipient part of its own — so two recipients of one write
 * sharing a correlationId would collide at the notification-events queue and the second would
 * be silently dropped.
 *
 * Colons are fine: every jobId goes through `buildJobId`, which escapes them.
 */
export type CalendarInviteWrite =
  | {
      readonly transition: 'booked';
      readonly calendarEventId: string;
      readonly sequence: number;
      readonly party: CalendarInviteParty;
      readonly recipient: CalendarInviteRecipient;
    }
  | {
      readonly transition: 'rescheduled';
      readonly rescheduleAuditId: string;
      readonly party: CalendarInviteParty;
      readonly recipient: CalendarInviteRecipient;
    }
  | { readonly transition: 'guest_added'; readonly guestId: string }
  /**
   * BAL-476 — the cancellation fan-out.
   *
   * ⚠ `cancelAuditId` IS THE PER-WRITE PART: an append-only `audit_events` row id minted once
   * per SUCCESSFUL cancel (`repositories/meetings.ts`'s `cancel`, and `cancelMeetingTx` on the
   * close cascade). ⚠ NEVER `meeting_calendar_events.id` — that id is stable across reschedules
   * and guest-adds, so the booking-time send would still sit inside BullMQ's
   * `removeOnComplete: { count: 100 }` window (`lib/queue.ts`) and swallow this job. Party +
   * recipient are what keep two recipients of one write from colliding.
   */
  | {
      readonly transition: 'cancelled';
      readonly cancelAuditId: string;
      readonly party: CalendarInviteParty;
      readonly recipient: CalendarInviteRecipient;
    }
  /**
   * BAL-476 — the guest-removal withdrawal.
   *
   * ⚠ PER-WRITE BECAUSE A GUEST ROW CAN BE REMOVED AT MOST ONCE: `meetingGuestsRepository.revoke`
   * WHEREs on `deleted_at IS NULL AND revoked_at IS NULL`, so a second removal returns
   * `undefined` and never reaches a publish. `MeetingGuestRemovedPayload`'s own comment says the
   * same ("stable: one removal per guest row").
   * ⚠⚠ THE `guest_removed:` PREFIX IS LOAD-BEARING — **do not reuse `guest_added:${guestId}`**.
   * Same row id, so the removal job would be silently swallowed by the add's retained job.
   */
  | { readonly transition: 'guest_removed'; readonly guestId: string };

export function calendarInviteCorrelationId(write: CalendarInviteWrite): string {
  switch (write.transition) {
    case 'booked':
      return `booked:${write.calendarEventId}:${write.sequence}:${write.party}:${calendarInviteRecipientKey(write.recipient)}`;
    case 'rescheduled':
      return `rescheduled:${write.rescheduleAuditId}:${write.party}:${calendarInviteRecipientKey(write.recipient)}`;
    case 'guest_added':
      return `guest_added:${write.guestId}`;
    case 'cancelled':
      return `cancelled:${write.cancelAuditId}:${write.party}:${calendarInviteRecipientKey(write.recipient)}`;
    case 'guest_removed':
      return `guest_removed:${write.guestId}`;
  }
}
