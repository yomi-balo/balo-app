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
  | { readonly transition: 'guest_added'; readonly guestId: string };

export function calendarInviteCorrelationId(write: CalendarInviteWrite): string {
  switch (write.transition) {
    case 'booked':
      return `booked:${write.calendarEventId}:${write.sequence}:${write.party}:${calendarInviteRecipientKey(write.recipient)}`;
    case 'rescheduled':
      return `rescheduled:${write.rescheduleAuditId}:${write.party}:${calendarInviteRecipientKey(write.recipient)}`;
    case 'guest_added':
      return `guest_added:${write.guestId}`;
  }
}
