import { CaseBillingReceiptEmail } from './case-billing-emails.js';
import { formatMeetingWindowUtc } from './meeting-guest-emails.js';

/**
 * BAL-411 — `reschedule_proposal.sent` and `reschedule_proposal.declined`. Two independent
 * templates sharing the `CaseBillingReceiptEmail` scaffold — the `booking-rescheduled.tsx`
 * precedent. Each exports its own `*Subject` function, consumed BOTH by the component itself
 * (as `previewText`) AND by `index.ts`'s registry entry, so a subject edit can never desync the
 * preheader from the registry — the exact bug already fixed once in `BookingRescheduledEmail`.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3): names cross the party boundary, addresses
 * never — `expertPersonLabel` / `declinedByLabel` are NAME labels, never email addresses.
 * ⚠ FEE CONCEALMENT: no rate, no total, no hold. A proposal — and a decline of one — moves no
 * money.
 * ⚠ NO CALENDAR CLAIM: nothing has moved yet (a proposal is a soft ask, not a booking).
 * ⚠ Warm, never adversarial. A proposal is normal, not a failure; the deadline is stated as a
 * helpful fact ("no rush — if it's not answered your original time simply stands"), never a
 * countdown.
 * ⚠ The CTA is `View case →`, never `meetings.join_url` and never a `/meeting/:id` route (there
 * is none) — mirrors `BookingRescheduledEmail`.
 */

function formatOption(iso: string): string {
  return formatMeetingWindowUtc(iso) || 'a new time';
}

// ── reschedule-proposal-sent ────────────────────────────────────────────────────────────────

export interface RescheduleProposalSentEmailProps {
  readonly firstName: string;
  /** Retrospective — a NAME with "@ company" on first mention, never an address. */
  readonly expertPersonLabel: string;
  readonly caseTitle: string;
  readonly originalScheduledStartIso: string;
  /** 1..3 ISO instants, in display order. */
  readonly optionStartIsos: readonly string[];
  readonly durationMinutes: number;
  readonly caseUrl: string;
  readonly baseUrl: string;
}

function sentBodyLines(props: Readonly<RescheduleProposalSentEmailProps>): string[] {
  const { expertPersonLabel, caseTitle, durationMinutes, optionStartIsos } = props;
  const originalWindow =
    formatMeetingWindowUtc(props.originalScheduledStartIso) || 'its scheduled time';
  const optionsLine = optionStartIsos.map(formatOption).join(' · ');
  // CONSIDER item — "a few other times" for a 1-option proposal, unlike `case-nudge.tsx`'s
  // `{optionCount} time{optionCount === 1 ? '' : 's'}`, which already gets the singular right.
  const timesPhrase = optionStartIsos.length === 1 ? 'another time' : 'a few other times';

  return [
    `${expertPersonLabel} suggested ${timesPhrase} for your consultation on ${caseTitle}, currently set for ${originalWindow} (${durationMinutes} min).`,
    `Other times that work for them: ${optionsLine}.`,
    `Pick one that suits, or keep your original time — no rush, and if it's not answered your original time simply stands.`,
  ];
}

/**
 * The subject line, shared with `index.ts`'s registry entry so the two never drift into two
 * different strings for the same email.
 */
export function rescheduleProposalSentSubject(expertPersonLabel: string): string {
  return `${expertPersonLabel} suggested a new time`;
}

export function RescheduleProposalSentEmail(props: Readonly<RescheduleProposalSentEmailProps>) {
  return (
    <CaseBillingReceiptEmail
      firstName={props.firstName}
      previewText={rescheduleProposalSentSubject(props.expertPersonLabel)}
      pillLabel="New time suggested"
      pillTone="primary"
      heading="A new time was suggested"
      subtext="Pick a time that works, or keep your original booking."
      bodyLines={sentBodyLines(props)}
      ctaLabel="View case →"
      ctaUrl={props.caseUrl}
      footerPrefix="Questions about this?"
      baseUrl={props.baseUrl}
    />
  );
}

// ── reschedule-proposal-declined ────────────────────────────────────────────────────────────

export interface RescheduleProposalDeclinedEmailProps {
  readonly firstName: string;
  /** Retrospective — a NAME with "@ company" on first mention, never an address. */
  readonly declinedByLabel: string;
  readonly caseTitle: string;
  readonly originalScheduledStartIso: string;
  readonly durationMinutes: number;
  readonly caseUrl: string;
  readonly baseUrl: string;
}

function declinedBodyLines(props: Readonly<RescheduleProposalDeclinedEmailProps>): string[] {
  const originalWindow =
    formatMeetingWindowUtc(props.originalScheduledStartIso) || 'the original time';
  return [
    `${props.declinedByLabel} kept the original time for ${props.caseTitle} — ${originalWindow} (${props.durationMinutes} min) still stands.`,
    `Nothing else to do here.`,
  ];
}

/**
 * The subject line, shared with `index.ts`'s registry entry so the two never drift into two
 * different strings for the same email.
 */
export function rescheduleProposalDeclinedSubject(declinedByLabel: string): string {
  return `${declinedByLabel} kept the original time`;
}

export function RescheduleProposalDeclinedEmail(
  props: Readonly<RescheduleProposalDeclinedEmailProps>
) {
  return (
    <CaseBillingReceiptEmail
      firstName={props.firstName}
      previewText={rescheduleProposalDeclinedSubject(props.declinedByLabel)}
      pillLabel="Original time kept"
      pillTone="primary"
      heading="Your original time stands"
      subtext="Nothing else to do here."
      bodyLines={declinedBodyLines(props)}
      ctaLabel="View case →"
      ctaUrl={props.caseUrl}
      footerPrefix="Questions?"
      baseUrl={props.baseUrl}
    />
  );
}
