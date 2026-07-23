import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/** Why the auto-top-up couldn't complete (BAL-379). */
export type AutoTopupFailureReason = 'declined' | 'requires_action';

/**
 * Props for the auto-top-up failed email (BAL-379). `attempted` is a pre-formatted AUD reload
 * face value; `reason` switches between the SCA "confirm your card" copy and the hard-decline
 * "update your card" copy. Calm and non-adversarial — an auto-top-up failure is NOT money owed
 * (no receivable, no dunning); the team can keep spending its existing balance. No "overdraft",
 * no countdown, no fee.
 */
export interface CreditAutoTopupFailedEmailProps {
  readonly firstName: string;
  readonly attempted: string;
  readonly reason: AutoTopupFailureReason;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Soft, neutral pill — a small optional fix, never an alarm (no receivable, nothing owed). */
const softPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(148, 163, 184, 0.16)',
  border: '1px solid rgba(148, 163, 184, 0.32)',
  color: 'rgba(255,255,255,0.75)',
};

/**
 * Auto-top-up failed email (BAL-379 / ADR-1040) — a calm heads-up to the billing admins that an
 * automatic top-up couldn't go through on the saved card. Deliberately gentle: nothing is owed
 * and nothing is on hold (the team keeps spending its existing balance); the only ask is to
 * refresh the card so auto-top-up keeps working. Gender-neutral, no "overdraft", no dunning.
 */
export function CreditAutoTopupFailedEmail({
  firstName = 'there',
  attempted,
  reason,
  ctaUrl,
  baseUrl,
}: Readonly<CreditAutoTopupFailedEmailProps>) {
  const needsConfirmation = reason === 'requires_action';
  const heroHeading = needsConfirmation
    ? 'Confirm your card to keep auto-top-up on'
    : 'A quick card update keeps auto-top-up on';
  const previewText = needsConfirmation
    ? 'Your card needs a quick confirmation to keep auto-top-up working.'
    : "We couldn't auto-top-up — a quick card update keeps it working.";
  const ctaLabel = needsConfirmation ? 'Confirm your card' : 'Update payment';
  const bodyLines = needsConfirmation
    ? [
        `We tried to add ${attempted} to your balance automatically, but the card needs a quick confirmation first.`,
        'Nothing is on hold — your team can keep using its current balance. Confirming the card just keeps auto-top-up ready for next time.',
      ]
    : [
        `We tried to add ${attempted} to your balance automatically, but the payment didn't go through.`,
        'Nothing is owed and nothing is on hold — your team can keep using its current balance. A quick card update keeps auto-top-up ready for next time.',
      ];

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero (soft, neutral tone) ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 A quick heads-up" style={softPillStyle} />
        <Heading style={shared.smallHeroHeading}>{heroHeading}</Heading>
        <Text style={shared.smallHeroSubtext}>
          Nothing&apos;s on hold — this just keeps it going.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        {bodyLines.map((line) => (
          <Text key={line} style={shared.bodyText}>
            {line}
          </Text>
        ))}

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            {ctaLabel} →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your balance?" />
      </Section>
    </EmailShell>
  );
}
