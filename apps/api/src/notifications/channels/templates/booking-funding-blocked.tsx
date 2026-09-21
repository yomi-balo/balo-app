import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the funding-blocked email (BAL-478). A Case booking was refused because the paying
 * company has neither an active payment mandate nor enough available credit to cover it.
 *
 * ⚠⚠ `requestedByLabel` ARRIVES PRE-COMPOSED (fix round 2, B2) — the resolver's
 * `hydrateBookingFundingBlockedActor` builds it from `requestedByUserId` via `personWithOrgLabel`
 * (F5: the "@ company" clause is staple-on only when a real name resolved), mirroring
 * `CreditSavedCardDetachedEmailProps`'s "pre-branched copy, no logic in the component" shape.
 * This component does NOT recompute it — a second `personWithOrgLabel` call here would be a
 * second, incomplete copy of the resolver's own self-notification filter.
 *
 * The recipient's own first name arrives as `firstName` (email adapter `recipientName`, resolved
 * per fanned-out billing admin). NO money figure anywhere — no balance, no shortfall, no rate,
 * no estimate.
 */
export interface BookingFundingBlockedEmailProps {
  readonly firstName: string;
  readonly requestedByLabel: string;
  readonly expertPartyLabel: string;
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

/**
 * Funding-blocked notice (BAL-478) — to the company's MANAGE_BILLING holders. A teammate tried
 * to book a consultation and the team's billing isn't set up to cover it yet. Warm, factual,
 * gender-neutral, non-adversarial: a solvable setup step, never a rejection.
 *
 * ⚠ B3 (fix round 2) — every line here is LITERALLY TRUE, not merely unpolished. Nothing was
 * written by the refused submit (the funding gate runs before the only write) and the slot is
 * still open to anyone — so this copy never says a time was "held" or a booking is "waiting".
 * The pill never claims to be "from your team" either — this is a Balo notice ABOUT a teammate's
 * attempt, not a message the team sent.
 */
export function BookingFundingBlockedEmail({
  firstName = 'there',
  requestedByLabel,
  expertPartyLabel,
  ctaUrl,
  baseUrl,
}: Readonly<BookingFundingBlockedEmailProps>) {
  const previewText = `${requestedByLabel} tried to book with ${expertPartyLabel}, but it couldn't go through — your team needs billing set up.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="🔔 A quick setup step" style={setupPillStyle} />
        <Heading style={shared.smallHeroHeading}>A booking couldn&apos;t go through</Heading>
        <Text style={shared.smallHeroSubtext}>
          One quick setup and the next attempt goes straight through.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {requestedByLabel} tried to book a consultation with {expertPartyLabel}, but it
          couldn&apos;t go through — your team needs a payment method on file, or enough credit to
          cover it. The time is still open to anyone; adding either one means your team can book
          without this happening again.
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            Set up billing →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about billing?" />
      </Section>
    </EmailShell>
  );
}
