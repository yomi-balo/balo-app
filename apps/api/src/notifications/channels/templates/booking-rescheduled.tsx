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

/**
 * BAL-411 — WHO moved it. `'client'` (the shipped BAL-409 path — a client-initiated,
 * auto-approved reschedule) or `'expert'` (the client just ACCEPTED the expert's own
 * proposal). The SHARED payload carried this field from day one (`BookingRescheduledPayload`)
 * so this ticket only had to widen the literal and branch the copy — see `introFor` and
 * `bookingRescheduledSubject` below.
 */
export type BookingRescheduledInitiator = 'client' | 'expert';

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
  /** `?? 'client'` at the call site (deploy-skew fallback) — see `index.ts`'s registry entries. */
  readonly initiatedBy: BookingRescheduledInitiator;
}

/**
 * BAL-411 — the intro line branches on BOTH `recipient` AND `initiatedBy`:
 *  · expert, initiatedBy=client  → unchanged ("{client} moved your consultation")
 *  · expert, initiatedBy=expert  → "{client} accepted your new time" — the expert proposed it,
 *    so "moved your consultation" would misattribute the ask to the client.
 *  · client, initiatedBy=client  → unchanged ("Your consultation … has moved")
 *  · client, initiatedBy=expert  → "You confirmed a new time with {expert}" — the client just
 *    ACCEPTED, so this is the acknowledgement of their own action, not something done to them.
 */
function introFor(
  recipient: BookingRescheduledRecipient,
  initiatedBy: BookingRescheduledInitiator,
  counterpartyLabel: string,
  newWindow: string,
  durationMinutes: number
): string {
  if (recipient === 'expert') {
    return initiatedBy === 'expert'
      ? `${counterpartyLabel} accepted your new time — ${newWindow} (${durationMinutes} min).`
      : `${counterpartyLabel} moved your consultation to ${newWindow} (${durationMinutes} min).`;
  }
  return initiatedBy === 'expert'
    ? `You confirmed a new time with ${counterpartyLabel} — ${newWindow} (${durationMinutes} min).`
    : `Your consultation with ${counterpartyLabel} has moved to ${newWindow} (${durationMinutes} min).`;
}

function bodyLines(props: Readonly<BookingRescheduledEmailProps>): string[] {
  const { recipient, counterpartyLabel, caseTitle, durationMinutes, initiatedBy } = props;
  const previousWindow =
    formatMeetingWindowUtc(props.previousScheduledStartIso) || 'its previous time';
  const newWindow = formatMeetingWindowUtc(props.scheduledStartIso) || 'the scheduled time';

  const intro = introFor(recipient, initiatedBy, counterpartyLabel, newWindow, durationMinutes);

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
  counterpartyLabel: string,
  initiatedBy: BookingRescheduledInitiator = 'client'
): string {
  if (recipient === 'expert') {
    return initiatedBy === 'expert'
      ? `${counterpartyLabel} accepted your new time`
      : `${counterpartyLabel} moved your consultation`;
  }
  return initiatedBy === 'expert'
    ? `You confirmed a new time with ${counterpartyLabel}`
    : `Your consultation with ${counterpartyLabel} has moved`;
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
  // BAL-411 — `initiatedBy` MUST thread through here too: this `subject` becomes the email's
  // hidden PREVIEW TEXT (`previewText={copy.subject}` below). Omitting it silently fell back to
  // the `'client'` default on `bookingRescheduledSubject`'s own signature, so an
  // `initiatedBy: 'expert'` render showed the CORRECT visible subject/body but leaked the
  // STALE "…moved your consultation" preheader — the one place an inbox list preview
  // misattributed the move to the client after they had just accepted it.
  const subject = bookingRescheduledSubject(
    props.recipient,
    props.counterpartyLabel,
    props.initiatedBy
  );
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
