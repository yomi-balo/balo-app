import { CaseBillingReceiptEmail } from './case-billing-emails.js';
import { formatMeetingWindowUtc } from './meeting-guest-emails.js';

/**
 * BAL-400 (D4) — `booking.confirmed`: a consultation was booked into a case. ONE parameterized
 * component serves BOTH recipients, discriminated on `recipient` — reuses the
 * `CaseBillingReceiptEmail` scaffold (the `case-billing-emails.tsx` precedent already followed
 * by `session-missed-call-client`/`-expert`) rather than hand-rolling a second copy of the
 * shell, so the two subjects cannot drift and cannot trip the SonarCloud new-code duplication
 * gate.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3): names cross the party boundary, addresses
 * never — `counterpartyLabel` is a NAME/ORG label, never an email address.
 * ⚠ FEE CONCEALMENT (D4c): no rate, no total, no estimate anywhere in this component. There is
 * none to leak — `BookingConfirmedPayload` carries no money field at all.
 * ⚠ NO CALENDAR CLAIM, EITHER SIDE (D2a/D2c). Only the expert's OWN calendar is ever written,
 * and that write is best-effort / non-blocking (an expert with no connection, or a
 * non-`ACTIVE` credential, is a normal case that fails silently). Asserting "this was added to
 * your calendar" would sometimes be false, so NEITHER template makes that claim — the CTA is
 * always the case, plus the join link only once the room is actually up.
 * ⚠ Prospective copy names the PARTY (CLAUDE.md) — `counterpartyLabel` is the client COMPANY
 * on the expert-facing email and the expert PARTY (agency, or the expert's own name if
 * independent) on the client-facing email. Never an invented individual, never a pronoun.
 */
export type BookingConfirmedRecipient = 'client' | 'expert';

export interface BookingConfirmedEmailProps {
  readonly recipient: BookingConfirmedRecipient;
  readonly firstName: string;
  /** Client company name (expert-facing email) or expert party label (client-facing email). */
  readonly counterpartyLabel: string;
  readonly caseTitle: string;
  readonly scheduledStartIso: string;
  readonly durationMinutes: number;
  readonly isNewCase: boolean;
  /** Count BEFORE this booking. Only referenced on an attach (`isNewCase: false`). */
  readonly priorConsultationCount: number;
  readonly guestCount: number;
  /** False ⇒ the Daily room is not up yet; the join link is withheld, never promised. */
  readonly provisioned: boolean;
  /** Absolute `${baseUrl}/join/m/{meetingId}` — the member route. Only rendered when provisioned. */
  readonly joinUrl: string;
  readonly caseUrl: string;
  readonly baseUrl: string;
}

/** "1 consultation" / "3 consultations" — never "0 consultations" (callers guard on isNewCase). */
function consultationCountPhrase(count: number): string {
  return count === 1 ? '1 consultation' : `${count} consultations`;
}

function bodyLines(props: Readonly<BookingConfirmedEmailProps>): string[] {
  const { recipient, counterpartyLabel, caseTitle, isNewCase, priorConsultationCount, guestCount } =
    props;
  const window = formatMeetingWindowUtc(props.scheduledStartIso) || 'the scheduled time';

  const intro =
    recipient === 'client'
      ? `Your consultation with ${counterpartyLabel} is confirmed for ${window} (${props.durationMinutes} min).`
      : `${counterpartyLabel} booked a consultation with you for ${window} (${props.durationMinutes} min).`;

  const caseLine = isNewCase
    ? `This opens a new case, ${caseTitle}, which you can track anytime.`
    : `This adds to your case, ${caseTitle} — ${consultationCountPhrase(priorConsultationCount)} so far.`;

  const lines = [intro, caseLine];

  if (guestCount > 0) {
    lines.push(
      guestCount === 1
        ? '1 guest has also been invited and will get their own join link.'
        : `${guestCount} guests have also been invited and will each get their own join link.`
    );
  }

  // ⚠ M6 — THE `provisioned: false` LINE MUST NOT PROMISE A DELIVERY NOTHING PERFORMS. There
  // is no repair sweep, no retry job and no on-demand provisioning at join time
  // (`join-meeting.ts` step 3 refuses an unprovisioned meeting outright), so the earlier copy
  // — "the join link will be ready before your call" — was an undertaking the platform cannot
  // keep. What IS true on this branch is that the failure was recorded loudly: `provisionVenue`
  // `log.error`s it and emits `meeting_provision_failed`. Say only that. The follow-up ticket
  // that adds the repair path is the one allowed to promise a link again.
  lines.push(
    props.provisioned
      ? `Join link: ${props.joinUrl}`
      : "Your time is held, but the call room isn't ready yet — our team has been alerted. Open the case for the latest."
  );

  return lines;
}

/**
 * The subject line, shared with `index.ts`'s registry entry (`TemplateOutput.subject`) so the
 * two never drift into two different strings for the same email.
 */
export function bookingConfirmedSubject(
  recipient: BookingConfirmedRecipient,
  counterpartyLabel: string,
  isNewCase: boolean
): string {
  if (recipient === 'client') {
    return isNewCase
      ? `Your consultation with ${counterpartyLabel} is confirmed`
      : `Another consultation with ${counterpartyLabel} is confirmed`;
  }
  return isNewCase
    ? `${counterpartyLabel} booked a consultation with you`
    : `${counterpartyLabel} booked another consultation with you`;
}

/** The client-facing preview/heading/subtext. */
function clientCopy(subject: string) {
  return {
    subject,
    heading: 'Your consultation is confirmed',
    subtext: 'A quiet confirmation — nothing else to do here.',
  };
}

/** The expert-facing preview/heading/subtext. */
function expertCopy(subject: string) {
  return {
    subject,
    heading: 'New booking',
    subtext: 'A new consultation has been booked with you.',
  };
}

export function BookingConfirmedEmail(props: Readonly<BookingConfirmedEmailProps>) {
  const subject = bookingConfirmedSubject(
    props.recipient,
    props.counterpartyLabel,
    props.isNewCase
  );
  const copy = props.recipient === 'client' ? clientCopy(subject) : expertCopy(subject);
  return (
    <CaseBillingReceiptEmail
      firstName={props.firstName}
      previewText={copy.subject}
      pillLabel="Booked"
      pillTone="primary"
      heading={copy.heading}
      subtext={copy.subtext}
      bodyLines={bodyLines(props)}
      ctaLabel="View case →"
      ctaUrl={props.caseUrl}
      footerPrefix="Questions about this booking?"
      baseUrl={props.baseUrl}
    />
  );
}

/** BAL-400 — `booking-confirmed-client`. Thin wrapper so the registry names it directly. */
export function BookingConfirmedClientEmail(
  props: Readonly<Omit<BookingConfirmedEmailProps, 'recipient'>>
) {
  return <BookingConfirmedEmail recipient="client" {...props} />;
}

/** BAL-400 — `booking-confirmed-expert`. Thin wrapper so the registry names it directly. */
export function BookingConfirmedExpertEmail(
  props: Readonly<Omit<BookingConfirmedEmailProps, 'recipient'>>
) {
  return <BookingConfirmedEmail recipient="expert" {...props} />;
}
