import type { MeetingReminderAudience, MeetingReminderOffset } from '../../events.js';
import { CaseBillingReceiptEmail } from './case-billing-emails.js';
import { formatMeetingWindowWithDuration } from './meeting-guest-emails.js';

/**
 * BAL-658 — `meeting.reminder_to_client` / `meeting.reminder_to_expert`: the 24-hour and 1-hour
 * email before a booked call. ONE parameterized component serves BOTH recipients, reusing the
 * `CaseBillingReceiptEmail` scaffold as `booking-confirmed.tsx` does.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3): `counterpartyName` is a NAME/ORG label, never
 * an address. The fallbacks ("your expert" / "your client") are name-free on purpose.
 */
export interface MeetingReminderEmailProps {
  readonly audience: MeetingReminderAudience;
  readonly offset: MeetingReminderOffset;
  readonly firstName: string;
  /** The other party's display name; absent ⇒ a party-neutral fallback. */
  readonly counterpartyName: string | null;
  /** The context's event label (e.g. "Consultation"); absent ⇒ "Call". */
  readonly callLabel: string | null;
  readonly scheduledStartIso: string;
  readonly durationMinutes: number;
  /** The recipient's own zone; absent, invalid or UTC ⇒ the email renders in UTC. */
  readonly recipientTimezone?: string | null;
  /** Absolute join URL. */
  readonly joinUrl: string;
  /** Absolute URL of the page the call lives on; `null` ⇒ no Reschedule line. */
  readonly rescheduleUrl: string | null;
  readonly baseUrl: string;
}

const OFFSET_PHRASE: Record<MeetingReminderOffset, string> = {
  '24h': '24 hours',
  '1h': '1 hour',
  '30m': '30 minutes',
};

const COUNTERPARTY_FALLBACK: Record<MeetingReminderAudience, string> = {
  client: 'your expert',
  expert: 'your client',
};

const DEFAULT_CALL_LABEL = 'Call';

/** Where rescheduling and cancelling happen — kept local so it never drifts with the invite copy. */
const RESCHEDULE_NOTE = 'Rescheduling and cancelling happen in Balo.';

function counterpartyOf(
  audience: MeetingReminderAudience,
  counterpartyName: string | null
): string {
  return counterpartyName !== null && counterpartyName.trim().length > 0
    ? counterpartyName
    : COUNTERPARTY_FALLBACK[audience];
}

/** The subject, shared with `index.ts`'s registry entry so the two never drift. */
export function meetingReminderSubject(
  audience: MeetingReminderAudience,
  callLabel: string | null,
  counterpartyName: string | null
): string {
  return `Coming up: ${callLabel ?? DEFAULT_CALL_LABEL} with ${counterpartyOf(audience, counterpartyName)}`;
}

function bodyLines(props: Readonly<MeetingReminderEmailProps>): string[] {
  const label = props.callLabel ?? DEFAULT_CALL_LABEL;
  const when = formatMeetingWindowWithDuration(
    props.scheduledStartIso,
    props.durationMinutes,
    props.recipientTimezone,
    'the scheduled time'
  );
  const lines = [
    `${label} with ${counterpartyOf(props.audience, props.counterpartyName)} starts ${when}.`,
    RESCHEDULE_NOTE,
  ];
  if (props.rescheduleUrl !== null) {
    lines.push(`Reschedule: ${props.rescheduleUrl}`);
  }
  return lines;
}

export function MeetingReminderEmail(props: Readonly<MeetingReminderEmailProps>) {
  const label = (props.callLabel ?? DEFAULT_CALL_LABEL).toLowerCase();
  return (
    <CaseBillingReceiptEmail
      firstName={props.firstName}
      previewText={meetingReminderSubject(props.audience, props.callLabel, props.counterpartyName)}
      pillLabel="Reminder"
      pillTone="primary"
      heading={`Your ${label} starts in ${OFFSET_PHRASE[props.offset]}`}
      subtext="A friendly heads-up. You can join from Balo shortly before the start."
      bodyLines={bodyLines(props)}
      ctaLabel="Join the call"
      ctaUrl={props.joinUrl}
      footerPrefix="Questions about this call?"
      baseUrl={props.baseUrl}
    />
  );
}
