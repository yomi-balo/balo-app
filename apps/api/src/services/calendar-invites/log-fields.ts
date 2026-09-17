import {
  CALENDAR_INVITE_CHANNEL,
  calendarInviteRecipientId,
  type CalendarInviteChannel,
  type CalendarInviteMethod,
  type CalendarInviteParty,
  type CalendarInviteSpec,
  type CalendarInviteTransition,
} from '../../notifications/calendar-invite-spec.js';

export interface CalendarInviteLogFields {
  readonly meetingId: string;
  readonly party: CalendarInviteParty;
  readonly recipientKind: 'user' | 'guest';
  readonly recipientUserId?: string;
  readonly guestId?: string;
  readonly contextType: string | null;
  readonly channel: CalendarInviteChannel;
  readonly sequence: number | null;
  readonly method: CalendarInviteMethod;
  readonly transition: CalendarInviteTransition;
  readonly calendarEventId: string;
}

/**
 * BAL-475 (O6) — ONE key set for every publish and delivery outcome. Ids and closed
 * vocabularies only; NEVER an address, a title, or a company name.
 */
export function calendarInviteLogFields(input: {
  readonly spec: CalendarInviteSpec;
  readonly contextType: string | null;
  readonly sequence: number | null;
}): CalendarInviteLogFields {
  const { spec, contextType, sequence } = input;
  const recipientId = calendarInviteRecipientId(spec.recipient);

  return {
    meetingId: spec.meetingId,
    party: spec.party,
    recipientKind: spec.recipient.kind,
    ...(spec.recipient.kind === 'user' ? { recipientUserId: recipientId } : {}),
    ...(spec.recipient.kind === 'guest' ? { guestId: recipientId } : {}),
    contextType,
    channel: CALENDAR_INVITE_CHANNEL,
    sequence,
    method: spec.method,
    transition: spec.transition,
    calendarEventId: spec.calendarEventId,
  };
}
