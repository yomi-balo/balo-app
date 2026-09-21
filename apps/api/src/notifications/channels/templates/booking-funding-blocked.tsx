import { Button, Heading, Section, Text } from '@react-email/components';
import { personWithOrgLabel } from '@balo/shared/parties';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the funding-blocked email (BAL-478). A Case booking was refused because the paying
 * company has neither an active payment mandate nor enough available credit to cover it.
 * `requestedByName` is the booker's display name — RETROSPECTIVE copy (CLAUDE.md), labelled
 * "@ {companyName}" on first mention via `personWithOrgLabel`, matching the SUBJECT's own
 * labelling (`templates/index.ts`'s factory) so one message does not split its own attribution.
 * The recipient's own first name arrives as `firstName` (email adapter `recipientName`, resolved
 * per fanned-out billing admin). NO money figure anywhere — no balance, no shortfall, no rate,
 * no estimate.
 */
export interface BookingFundingBlockedEmailProps {
  readonly firstName: string;
  readonly requestedByName: string;
  /** `undefined` degrades `personWithOrgLabel` to the bare name — never a placeholder string. */
  readonly companyName: string | undefined;
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
 */
export function BookingFundingBlockedEmail({
  firstName = 'there',
  requestedByName,
  companyName,
  expertPartyLabel,
  ctaUrl,
  baseUrl,
}: Readonly<BookingFundingBlockedEmailProps>) {
  const requestedByLabel = personWithOrgLabel(requestedByName, companyName);
  const previewText = `${requestedByLabel} went to book with ${expertPartyLabel}, and your team needs billing set up first.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="🔔 A setup step from your team" style={setupPillStyle} />
        <Heading style={shared.smallHeroHeading}>A booking is waiting on billing</Heading>
        <Text style={shared.smallHeroSubtext}>One setup step and your team is moving again.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {requestedByLabel} went to book a consultation with {expertPartyLabel}, and we
          couldn&apos;t hold the time yet — your team needs a payment method on file, or enough
          credit to cover the consultation. Adding either one unblocks them straight away.
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
