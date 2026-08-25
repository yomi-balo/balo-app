import { personWithOrgLabel } from '@balo/shared/parties';
import { CaseBillingReceiptEmail } from './case-billing-emails.js';
import { formatMeetingWindowUtc } from './meeting-guest-emails.js';

/**
 * BAL-283 — the three `conversation.availability_shared` / `conversation.intro_call_booked`
 * email templates. Reuses the `CaseBillingReceiptEmail` scaffold (the `booking-confirmed.tsx` /
 * `session-missed-call` precedent) rather than hand-rolling a third shell, so the two `.sent`
 * arms cannot drift and cannot trip the SonarCloud new-code duplication gate.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3): names cross the party boundary, addresses
 * never. Every label prop here is a NAME/ORG label, never an email address.
 * ⚠ NO MONEY, ANYWHERE. An intro call is unbilled (Ruling 2) — no rate, no total, no hold; the
 * payloads carry no money field to leak.
 * ⚠ `intro-call-booked-*` MUST branch on `provisioned` and never promise a live join link when
 * it is `false` — same discipline as `booking-confirmed-*`.
 * ⚠ `availability-shared-client` links the CONVERSATION (`/projects/{requestId}`), never a raw
 * booking deep link — one entry point into the dialog (design §Flow B).
 */

// ── availability_shared ─────────────────────────────────────────────────────────────────

export interface AvailabilitySharedClientEmailProps {
  readonly firstName: string;
  /** Retrospective — a PERSON name, "@ party" on first mention (CLAUDE.md). */
  readonly expertPersonName: string;
  readonly expertPartyLabel: string;
  readonly requestTitle: string;
  readonly requestUrl: string;
  readonly baseUrl: string;
}

/**
 * ⚠ `personWithOrgLabel`, NEVER `` `${person} @ ${org}` `` (round-1 W1). For an INDEPENDENT
 * expert — a first-class cohort here, not an edge case — `expertPartyDisplayName` returns the
 * PERSON'S OWN NAME as the party label, so the hand-concatenation rendered the subject line
 * *"Dana Okoro @ Dana Okoro is free — pick a time"*. `personWithOrgLabel` is the one place the
 * "@ org" clause is decided and drops it in exactly that case (and when the label is blank).
 */
export function availabilitySharedSubject(
  expertPersonName: string,
  expertPartyLabel: string
): string {
  return `${personWithOrgLabel(expertPersonName, expertPartyLabel)} is free — pick a time`;
}

/** BAL-283 — `availability-shared-client`. */
export function AvailabilitySharedClientEmail({
  firstName,
  expertPersonName,
  expertPartyLabel,
  requestTitle,
  requestUrl,
  baseUrl,
}: Readonly<AvailabilitySharedClientEmailProps>) {
  const subject = availabilitySharedSubject(expertPersonName, expertPartyLabel);
  return (
    <CaseBillingReceiptEmail
      firstName={firstName}
      previewText={subject}
      pillLabel="Ready"
      pillTone="primary"
      heading="An expert is ready to talk"
      subtext="No forms, no commitment — just pick a time."
      bodyLines={[
        `${personWithOrgLabel(expertPersonName, expertPartyLabel)} shared their availability on "${requestTitle}".`,
        'A quick intro call is the fastest way to gauge fit. Meetings are free.',
      ]}
      ctaLabel="Pick a time →"
      ctaUrl={requestUrl}
      footerPrefix="Questions about this request?"
      baseUrl={baseUrl}
    />
  );
}

// ── intro_call_booked ───────────────────────────────────────────────────────────────────

export type IntroCallBookedRecipient = 'client' | 'expert';

export interface IntroCallBookedEmailProps {
  readonly recipient: IntroCallBookedRecipient;
  readonly firstName: string;
  /** Client company name (expert-facing email) or expert party label (client-facing email). */
  readonly counterpartyLabel: string;
  readonly requestTitle: string;
  readonly scheduledStartIso: string;
  readonly durationMinutes: number;
  readonly guestCount: number;
  /** False ⇒ the Daily room is not up yet; the join link is withheld, never promised. */
  readonly provisioned: boolean;
  /** Absolute `${baseUrl}/join/m/{meetingId}` — the member route. Only rendered when provisioned. */
  readonly joinUrl: string;
  readonly requestUrl: string;
  readonly baseUrl: string;
}

export function introCallBookedSubject(
  recipient: IntroCallBookedRecipient,
  counterpartyLabel: string
): string {
  return recipient === 'client'
    ? `Your intro call with ${counterpartyLabel} is confirmed`
    : `${counterpartyLabel} booked an intro call with you`;
}

function introCallBodyLines(props: Readonly<IntroCallBookedEmailProps>): string[] {
  const { recipient, counterpartyLabel, requestTitle, guestCount } = props;
  const window = formatMeetingWindowUtc(props.scheduledStartIso) || 'the scheduled time';

  const intro =
    recipient === 'client'
      ? `Your intro call with ${counterpartyLabel} is confirmed for ${window} (${props.durationMinutes} min).`
      : `${counterpartyLabel} booked an intro call with you for ${window} (${props.durationMinutes} min).`;

  const lines = [intro, `Free — no charge, no commitment. This is about "${requestTitle}".`];

  if (guestCount > 0) {
    lines.push(
      guestCount === 1
        ? '1 guest has also been invited and will get their own join link.'
        : `${guestCount} guests have also been invited and will each get their own join link.`
    );
  }

  // ⚠ SAME NON-PROMISE AS `booking-confirmed.tsx` — no repair sweep, no retry job. Say only
  // what actually happened.
  lines.push(
    props.provisioned
      ? `Join link: ${props.joinUrl}`
      : "Your time is held, but the call room isn't ready yet — our team has been alerted."
  );

  return lines;
}

function introCallCopy(recipient: IntroCallBookedRecipient, subject: string) {
  return recipient === 'client'
    ? {
        subject,
        heading: 'Your intro call is confirmed',
        subtext: 'A quiet confirmation — nothing else to do here.',
      }
    : {
        subject,
        heading: 'A new intro call was booked',
        subtext: 'Momentum — a client wants to talk to you.',
      };
}

export function IntroCallBookedEmail(props: Readonly<IntroCallBookedEmailProps>) {
  const subject = introCallBookedSubject(props.recipient, props.counterpartyLabel);
  const copy = introCallCopy(props.recipient, subject);
  return (
    <CaseBillingReceiptEmail
      firstName={props.firstName}
      previewText={copy.subject}
      pillLabel="Booked"
      pillTone="success"
      heading={copy.heading}
      subtext={copy.subtext}
      bodyLines={introCallBodyLines(props)}
      ctaLabel="Back to conversation →"
      ctaUrl={props.requestUrl}
      footerPrefix="Questions about this call?"
      baseUrl={props.baseUrl}
    />
  );
}

/** BAL-283 — `intro-call-booked-client`. Thin wrapper so the registry names it directly. */
export function IntroCallBookedClientEmail(
  props: Readonly<Omit<IntroCallBookedEmailProps, 'recipient'>>
) {
  return <IntroCallBookedEmail recipient="client" {...props} />;
}

/** BAL-283 — `intro-call-booked-expert`. Thin wrapper so the registry names it directly. */
export function IntroCallBookedExpertEmail(
  props: Readonly<Omit<IntroCallBookedEmailProps, 'recipient'>>
) {
  return <IntroCallBookedEmail recipient="expert" {...props} />;
}
