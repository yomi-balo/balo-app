import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter, pluralize } from './shared.js';
import {
  topUpPhrase,
  upperFirst,
  type FundingBlockNotice,
  type TopUpFigure,
} from './top-up-figure.js';

/**
 * Props for the funding-blocked email. A Case booking was refused, and `notice` says why:
 *
 * - `unfunded` (BAL-478) — the paying company has neither an active payment mandate nor enough
 *   available credit. Carries NO money figure.
 * - `hold` / `hold_fallback` (BAL-474, ADR-1040 Amendment 7 §H) — an open receivable is holding
 *   the account. `hold` quotes the dated top-up that clears it; `hold_fallback` is the one state
 *   with no figure (a covered hold the booking API could not clear) and never renders `A$0.00`.
 * - `reserved` (BAL-474) — part of the credit is set aside for planned consultations. It quotes
 *   the dated top-up that would make room and the COUNT of planned consultations, nothing about
 *   whose they are or when.
 *
 * ⚠⚠ `requestedByLabel` ARRIVES PRE-COMPOSED (fix round 2, B2) — the resolver's
 * `hydrateBookingFundingBlockedActor` builds it from `requestedByUserId` via `personWithOrgLabel`
 * (F5: the "@ company" clause is staple-on only when a real name resolved), mirroring
 * `CreditSavedCardDetachedEmailProps`'s "pre-branched copy, no logic in the component" shape.
 * This component does NOT recompute it — a second `personWithOrgLabel` call here would be a
 * second, incomplete copy of the resolver's own self-notification filter.
 *
 * The recipient's own first name arrives as `firstName` (email adapter `recipientName`, resolved
 * per fanned-out billing admin). `companyLabel` is the paying company's name, or "your team".
 * Every figure arrives pre-formatted inside `notice` — no rate, no estimate, no fee anywhere.
 */
export interface BookingFundingBlockedEmailProps {
  readonly firstName: string;
  readonly requestedByLabel: string;
  readonly expertPartyLabel: string;
  readonly companyLabel: string;
  readonly notice: FundingBlockNotice;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Calm, informational pill — a setup step, never a failure or a dunning notice. */
const setupPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

/** The subject of the funding-blocked email. Labels arrive already run through `sanitizeSubjectTitle`. */
export function bookingFundingBlockedSubject(
  notice: FundingBlockNotice,
  requestedByLabel: string,
  companyLabel: string
): string {
  switch (notice.variant) {
    case 'hold':
      return `${requestedByLabel} couldn't book — ${companyLabel}'s balance needs a top-up`;
    case 'hold_fallback':
      return `${requestedByLabel} couldn't book — an earlier hold on ${companyLabel}'s account was still clearing`;
    case 'reserved':
      return `${requestedByLabel} couldn't book — part of ${companyLabel}'s balance was set aside for planned consultations`;
    default:
      return `${requestedByLabel} needs billing set up to book`;
  }
}

/** The note that follows a large figure and names the top-up page's per-top-up maximum. */
function eachTopUpNote(
  figure: TopUpFigure,
  lead: 'each top-up can be up to' | 'each up to'
): string {
  return figure.exceedsSingleTopUp ? ` (${lead} ${figure.maxTopUp})` : '';
}

/** The preheader — dated, "or more", describing the action and never a booking result. */
function previewTextFor(props: Readonly<BookingFundingBlockedEmailProps>): string {
  const { notice, requestedByLabel, expertPartyLabel, companyLabel } = props;
  switch (notice.variant) {
    case 'hold': {
      const verb = notice.figure.exceedsSingleTopUp ? 'clear' : 'clears';
      return `As of ${notice.figure.asOf}, ${topUpPhrase(notice.figure)} ${verb} ${companyLabel}'s balance.`;
    }
    case 'hold_fallback':
      return 'The balance already covered it — it lifts automatically within a day, or at once with any top-up.';
    case 'reserved':
      return `As of ${notice.figure.asOf}, ${topUpPhrase(notice.figure)} would make room for it alongside the ${pluralize(notice.count, 'upcoming consultation')} already planned.`;
    default:
      return `${requestedByLabel} tried to book with ${expertPartyLabel}, but it couldn't go through — your team needs billing set up.`;
  }
}

/** The body paragraph. Past tense for the refusal, "would" for a computed consequence. */
function bodyFor(props: Readonly<BookingFundingBlockedEmailProps>): string {
  const { notice, requestedByLabel, expertPartyLabel, companyLabel } = props;
  const attempt = `${requestedByLabel} tried to book a consultation with ${expertPartyLabel}, but it couldn't go through`;
  switch (notice.variant) {
    case 'hold':
      return `${attempt}. As of ${notice.figure.asOf}, ${companyLabel}'s balance needs ${topUpPhrase(notice.figure)}${eachTopUpNote(notice.figure, 'each top-up can be up to')} before new consultations can be booked. Nothing was booked, so no time was held. Once it's topped up, your team can try booking again.`;
    case 'hold_fallback':
      return `${attempt}: an earlier hold was still on ${companyLabel}'s account, although the balance already covered it. Nothing was booked, so no time was held. The hold lifts automatically within a day, or at once with any top-up, and then your team can try booking again.`;
    case 'reserved':
      return `${attempt}: as of ${notice.figure.asOf}, part of ${companyLabel}'s balance was set aside for ${pluralize(notice.count, 'upcoming consultation')}, so there wasn't enough left for this one. ${upperFirst(topUpPhrase(notice.figure))}${eachTopUpNote(notice.figure, 'each up to')} would make room for it. Nothing was booked, so no time was held, and nothing had been taken from ${companyLabel}'s balance for the planned consultations.`;
    default:
      return `${attempt} — your team needs a payment method on file, or enough credit to cover it. Nothing was booked, so no time was held. Add either one and your team can try booking again.`;
  }
}

/** The line under the heading. Every arm says what the refusal did NOT touch. */
function subheadingFor(notice: FundingBlockNotice): string {
  switch (notice.variant) {
    case 'hold':
    case 'hold_fallback':
      return "Consultations already booked aren't affected.";
    case 'reserved':
      return "Planned consultations aren't affected.";
    default:
      return 'One quick setup and your team can try booking again.';
  }
}

/**
 * Funding-blocked notice (BAL-478, extended by BAL-474) — to the company's MANAGE_BILLING holders.
 * A teammate tried to book a consultation and it was refused; the notice says why and what the
 * billing admin can do. Warm, factual, gender-neutral, non-adversarial: a solvable step, never a
 * rejection.
 *
 * ⚠⚠ EVERY LINE MUST STAY TRUE AT READ TIME, NOT JUST AT SEND TIME (fix round 3). Nothing was
 * written by the refused submit (the funding gate runs before the only write), so the copy
 * states that PAST FACT ("nothing was booked, so no time was held") rather than a PRESENT-TENSE
 * claim about the slot's current availability — a billing admin might read this hours later,
 * by which point "the slot is still open" could easily be false. The pill never claims to be
 * "from your team" either — this is a Balo notice ABOUT a teammate's attempt, not a message the
 * team sent. A money figure is dated "as of" the instant it was read, for the same reason.
 *
 * ⚠⚠ NO PROMISED OUTCOME, EITHER (fix round 3). "The next attempt goes straight through" / "book
 * without this happening again" are promises the gate itself is designed to break — a top-up
 * covers only what it covers, a longer booking or a drained balance hits the gate again, another
 * teammate's booking can move the figure, and a card can be removed between now and the next
 * attempt. This copy describes the ACTION available ("your team can try booking again") and a
 * computed consequence as "would", never a guaranteed result.
 */
export function BookingFundingBlockedEmail(props: Readonly<BookingFundingBlockedEmailProps>) {
  const { firstName = 'there', notice, ctaUrl, baseUrl } = props;
  const unfunded = notice.variant === 'unfunded';

  return (
    <EmailShell previewText={previewTextFor(props)} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill
          label={unfunded ? '🔔 A quick setup step' : '🔔 A quick heads-up'}
          style={setupPillStyle}
        />
        <Heading style={shared.smallHeroHeading}>A booking couldn&apos;t go through</Heading>
        <Text style={shared.smallHeroSubtext}>{subheadingFor(notice)}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{bodyFor(props)}</Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            {unfunded ? 'Set up billing' : 'Top up'} →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about billing?" />
      </Section>
    </EmailShell>
  );
}
