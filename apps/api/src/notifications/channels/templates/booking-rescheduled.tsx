import { CaseBillingReceiptEmail } from './case-billing-emails.js';
import { formatMeetingWindowUtc } from './meeting-guest-emails.js';

/**
 * BAL-409 — `booking.rescheduled`: a booked consultation was moved by the CLIENT. ONE
 * parameterized component serves BOTH recipients, discriminated on `recipient` — reuses the
 * `CaseBillingReceiptEmail` scaffold, the exact `booking-confirmed.tsx` precedent, so the two
 * subjects cannot drift and cannot trip the SonarCloud new-code duplication gate.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3): names cross the party boundary, addresses
 * never — `counterpartyLabel` is a NAME/ORG label, never an email address.
 * ⚠ FEE CONCEALMENT: no rate, no total, no hold. A reschedule moves no money.
 * ⚠ NO CALENDAR CLAIM ON THE CLIENT SIDE (D14). The expert-side email may say their calendar
 * has been updated ONLY if the amend has actually run — it has NOT at publish time (the
 * calendar amend is a retrying BullMQ job that fires after this email), so this template says
 * so on NEITHER side. Say only what is unambiguously true: the new time.
 * ⚠ Prospective copy names the PARTY (CLAUDE.md) — `counterpartyLabel` is the client COMPANY
 * on the expert-facing email and the expert PARTY on the client-facing email.
 */
export type BookingRescheduledRecipient = 'client' | 'expert';

export interface BookingRescheduledEmailProps {
  readonly recipient: BookingRescheduledRecipient;
  readonly firstName: string;
  /** Client company name (expert-facing email) or expert party label (client-facing email). */
  readonly counterpartyLabel: string;
  readonly caseTitle: string;
  readonly previousScheduledStartIso: string;
  readonly scheduledStartIso: string;
  readonly durationMinutes: number;
  readonly caseUrl: string;
  readonly baseUrl: string;
}

function bodyLines(props: Readonly<BookingRescheduledEmailProps>): string[] {
  const { recipient, counterpartyLabel, caseTitle, durationMinutes } = props;
  const previousWindow =
    formatMeetingWindowUtc(props.previousScheduledStartIso) || 'its previous time';
  const newWindow = formatMeetingWindowUtc(props.scheduledStartIso) || 'the scheduled time';

  const intro =
    recipient === 'client'
      ? `Your consultation with ${counterpartyLabel} has moved to ${newWindow} (${durationMinutes} min).`
      : `${counterpartyLabel} moved your consultation to ${newWindow} (${durationMinutes} min).`;

  return [
    intro,
    `It was previously scheduled for ${previousWindow} — same length, same link.`,
    `Part of your case, ${caseTitle}.`,
  ];
}

/**
 * The subject line, shared with `index.ts`'s registry entry so the two never drift into two
 * different strings for the same email.
 */
export function bookingRescheduledSubject(
  recipient: BookingRescheduledRecipient,
  counterpartyLabel: string
): string {
  return recipient === 'client'
    ? `Your consultation with ${counterpartyLabel} has moved`
    : `${counterpartyLabel} moved your consultation`;
}

/** The client-facing preview/heading/subtext. */
function clientCopy(subject: string) {
  return {
    subject,
    heading: 'Your consultation moved',
    subtext: 'A quiet heads-up — nothing else to do here.',
  };
}

/** The expert-facing preview/heading/subtext. */
function expertCopy(subject: string) {
  return {
    subject,
    heading: 'A booking moved',
    subtext: 'A consultation on your calendar was rescheduled.',
  };
}

export function BookingRescheduledEmail(props: Readonly<BookingRescheduledEmailProps>) {
  const subject = bookingRescheduledSubject(props.recipient, props.counterpartyLabel);
  const copy = props.recipient === 'client' ? clientCopy(subject) : expertCopy(subject);
  return (
    <CaseBillingReceiptEmail
      firstName={props.firstName}
      previewText={copy.subject}
      pillLabel="Rescheduled"
      pillTone="primary"
      heading={copy.heading}
      subtext={copy.subtext}
      bodyLines={bodyLines(props)}
      ctaLabel="View case →"
      ctaUrl={props.caseUrl}
      footerPrefix="Questions about this change?"
      baseUrl={props.baseUrl}
    />
  );
}

/** BAL-409 — `booking-rescheduled-client`. Thin wrapper so the registry names it directly. */
export function BookingRescheduledClientEmail(
  props: Readonly<Omit<BookingRescheduledEmailProps, 'recipient'>>
) {
  return <BookingRescheduledEmail recipient="client" {...props} />;
}

/** BAL-409 — `booking-rescheduled-expert`. Thin wrapper so the registry names it directly. */
export function BookingRescheduledExpertEmail(
  props: Readonly<Omit<BookingRescheduledEmailProps, 'recipient'>>
) {
  return <BookingRescheduledEmail recipient="expert" {...props} />;
}
