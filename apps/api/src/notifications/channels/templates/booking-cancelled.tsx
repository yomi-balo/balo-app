import { CaseBillingReceiptEmail } from './case-billing-emails.js';
import { formatMeetingWindowUtc } from './meeting-guest-emails.js';

/**
 * BAL-410 — `booking.cancelled`: a booked consultation was cancelled. ONE parameterized
 * component serves BOTH recipients, discriminated on `recipient` — reuses the
 * `CaseBillingReceiptEmail` scaffold, the exact `booking-confirmed.tsx` / `booking-rescheduled.tsx`
 * precedent, so the two subjects cannot drift and cannot trip the SonarCloud new-code
 * duplication gate.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3): names cross the party boundary, addresses
 * NEVER. `counterpartyLabel` and `cancelledByLabel` are NAME/ORG labels, never email addresses;
 * `booking-cancelled.test.ts` asserts over the RENDERED OUTPUT that the only address anywhere is
 * `support@getbalo.com`.
 *
 * ⚠⚠ NO HOLD-RELEASE LANGUAGE IN THE EMAIL, ON EITHER SIDE, EVEN WHEN A HOLD WAS RELEASED. The
 * ticket is explicit: "Hold released → client → in-app only. Not email — no money moved, and an
 * email implies something went wrong." The `holdReleased` flag is deliberately NOT a prop of this
 * component; the in-app client template is the one surface that branches on it. Do not "improve"
 * this by adding a reassuring line about the balance — the reassurance the email owes is
 * "nothing was charged", which it says unconditionally because it is unconditionally true.
 *
 * ⚠ FEE CONCEALMENT: no rate, no total, no hold amount, no balance. A cancellation moves no
 * money at all.
 *
 * ⚠ ATTRIBUTION BY TENSE (CLAUDE.md). This email is RETROSPECTIVE — it reports something that
 * happened — so it names the PERSON who cancelled with "@ company/agency" on first mention
 * (`cancelledByLabel`, assembled by the publisher). The one place it is PROSPECTIVE ("you can
 * book another time with X") names the PARTY. On the admin arm `cancelledByLabel` is the literal
 * `'Balo support'`: a Balo staff member is never named to the parties.
 *
 * ⚠ WARM, NON-ADVERSARIAL, GENDER-NEUTRAL. No countdown, no deadline, no penalty language, no
 * "you missed", and no gendered pronoun anywhere — parties are named, or "they".
 */
export type BookingCancelledRecipient = 'client' | 'expert';

/** WHICH AXIS authorized the cancel. Server-derived; never taken from the wire. */
export type BookingCancelledInitiator = 'client' | 'expert' | 'admin';

/**
 * WHY it was cancelled. `'requested'` is the only value any shipped caller passes;
 * `'expert_time_off'` is BAL-416's cancel branch, carried here as a REASON VARIANT of this same
 * family (never a second event family) so its producer needs no template work.
 */
export type BookingCancelledReason = 'requested' | 'expert_time_off';

export interface BookingCancelledEmailProps {
  readonly recipient: BookingCancelledRecipient;
  readonly firstName: string;
  /** Client company name (expert-facing email) or expert party label (client-facing email). */
  readonly counterpartyLabel: string;
  /** RETROSPECTIVE: the person who cancelled, "@ party" on first mention. `'Balo support'` on
   *  the admin arm. */
  readonly cancelledByLabel: string;
  readonly caseTitle: string;
  readonly scheduledStartIso: string;
  readonly durationMinutes: number;
  readonly cancelledBy: BookingCancelledInitiator;
  readonly reason: BookingCancelledReason;
  readonly caseUrl: string;
  readonly baseUrl: string;
}

/**
 * The opening line: WHO cancelled WHAT. Branches on `recipient` × `cancelledBy` × `reason`.
 *
 * · A recipient who cancelled it themselves reads an acknowledgement of their OWN act
 *   ("You cancelled …"), never a report of something done to them.
 * · The `expert_time_off` variant states the reason as a helpful fact, in the PASSIVE, with no
 *   apology-on-someone's-behalf and no implication that anyone is at fault.
 * · The admin arm names `'Balo support'` and nobody else.
 */
function introFor(props: Readonly<BookingCancelledEmailProps>, window: string): string {
  const { recipient, cancelledBy, reason, counterpartyLabel, cancelledByLabel } = props;
  const actedThemselves =
    (recipient === 'client' && cancelledBy === 'client') ||
    (recipient === 'expert' && cancelledBy === 'expert');

  if (actedThemselves) {
    return `You cancelled the consultation with ${counterpartyLabel} on ${window}.`;
  }
  if (reason === 'expert_time_off') {
    return `The consultation with ${counterpartyLabel} on ${window} has been cancelled — that time is no longer available on ${counterpartyLabel}'s calendar.`;
  }
  return `${cancelledByLabel} cancelled the consultation on ${window}.`;
}

/**
 * The body. Three lines, always in this order: what happened, that nothing was charged, and
 * what can happen next.
 *
 * ⚠ "NOTHING WAS CHARGED" IS UNCONDITIONAL AND IS THE POINT OF THE WHOLE EMAIL — it is the
 * product promise ("free until scheduled start") restated at the one moment it matters. It says
 * nothing about a hold, a balance or a release: see the module docblock.
 */
function bodyLines(props: Readonly<BookingCancelledEmailProps>): string[] {
  const window = formatMeetingWindowUtc(props.scheduledStartIso) || 'the scheduled time';
  const nextStep =
    props.recipient === 'client'
      ? `Whenever it suits, you can book another time with ${props.counterpartyLabel} from the case.`
      : `That slot is open on your calendar again, and ${props.counterpartyLabel} can book another time whenever they are ready.`;

  return [
    introFor(props, window),
    `It was a ${props.durationMinutes}-minute call — nothing was charged, and there is nothing to settle.`,
    `Part of your case, ${props.caseTitle}. ${nextStep}`,
  ];
}

/**
 * The subject line, shared with `index.ts`'s registry entry so the two never drift into two
 * different strings for the same email.
 */
export function bookingCancelledSubject(
  recipient: BookingCancelledRecipient,
  counterpartyLabel: string,
  cancelledBy: BookingCancelledInitiator = 'client',
  reason: BookingCancelledReason = 'requested'
): string {
  const actedThemselves =
    (recipient === 'client' && cancelledBy === 'client') ||
    (recipient === 'expert' && cancelledBy === 'expert');
  if (actedThemselves) {
    return `You cancelled your consultation with ${counterpartyLabel}`;
  }
  if (reason === 'expert_time_off') {
    return `Your consultation with ${counterpartyLabel} has been cancelled`;
  }
  return recipient === 'client'
    ? `Your consultation with ${counterpartyLabel} was cancelled`
    : `${counterpartyLabel} cancelled a consultation`;
}

/** The client-facing preview/heading/subtext. */
function clientCopy(subject: string) {
  return {
    subject,
    heading: 'Your consultation was cancelled',
    subtext: 'Nothing was charged — book another time whenever you are ready.',
  };
}

/** The expert-facing preview/heading/subtext. */
function expertCopy(subject: string) {
  return {
    subject,
    heading: 'A booking was cancelled',
    subtext: 'That slot is free on your calendar again.',
  };
}

export function BookingCancelledEmail(props: Readonly<BookingCancelledEmailProps>) {
  // ⚠ `cancelledBy` AND `reason` MUST THREAD THROUGH HERE TOO: this `subject` becomes the
  // email's hidden PREVIEW TEXT (`previewText={copy.subject}` below). Omitting either would
  // silently fall back to the signature's defaults, showing the correct visible subject and
  // body while leaking a mis-attributed preheader into the inbox list — the exact regression
  // `booking-rescheduled.tsx` records for its own `initiatedBy`.
  const subject = bookingCancelledSubject(
    props.recipient,
    props.counterpartyLabel,
    props.cancelledBy,
    props.reason
  );
  const copy = props.recipient === 'client' ? clientCopy(subject) : expertCopy(subject);
  return (
    <CaseBillingReceiptEmail
      firstName={props.firstName}
      previewText={copy.subject}
      pillLabel="Cancelled"
      pillTone="muted"
      heading={copy.heading}
      subtext={copy.subtext}
      bodyLines={bodyLines(props)}
      ctaLabel="View case →"
      ctaUrl={props.caseUrl}
      footerPrefix="Questions about this cancellation?"
      baseUrl={props.baseUrl}
    />
  );
}

/** BAL-410 — `booking-cancelled-client`. Thin wrapper so the registry names it directly. */
export function BookingCancelledClientEmail(
  props: Readonly<Omit<BookingCancelledEmailProps, 'recipient'>>
) {
  return <BookingCancelledEmail recipient="client" {...props} />;
}

/** BAL-410 — `booking-cancelled-expert`. Thin wrapper so the registry names it directly. */
export function BookingCancelledExpertEmail(
  props: Readonly<Omit<BookingCancelledEmailProps, 'recipient'>>
) {
  return <BookingCancelledEmail recipient="expert" {...props} />;
}
