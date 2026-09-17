import type { SendMailOptions } from 'nodemailer';

/**
 * BAL-475 — the calendar-class message constructor. PURE (type-only nodemailer import, never a
 * value one — the counterparty-address invariant's `nodemailer-only-in-email-channel.test.ts`
 * pins `email.adapter.ts` as the ONLY value-importer).
 */

export const CALENDAR_INVITE_FILENAME = 'invite.ics';
const CALENDAR_INVITE_FROM_NAME = 'Balo';

export interface CalendarInviteMailInput {
  readonly organizerAddress: string;
  readonly recipientAddress: string;
  readonly recipientName: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly ics: string;
}

/**
 * The ONLY constructor of a calendar-class message. Returns nodemailer options with `icalEvent`
 * and WITHOUT an `attachments` key — ADR-1044 Ruling 4 guardrail 2: nodemailer's own source
 * warns that attachments beside a calendar alternative blank the message on some clients.
 */
export function buildCalendarInviteMailOptions(input: CalendarInviteMailInput): SendMailOptions {
  return {
    from: { name: CALENDAR_INVITE_FROM_NAME, address: input.organizerAddress },
    to: { name: input.recipientName, address: input.recipientAddress },
    subject: input.subject,
    text: input.text,
    html: input.html,
    icalEvent: {
      method: 'REQUEST',
      filename: CALENDAR_INVITE_FILENAME,
      content: input.ics,
    },
  };
}
