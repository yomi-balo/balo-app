import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/** Why the settlement couldn't complete (BAL-378). */
export type SettlementFailureReason = 'declined' | 'requires_action';

/**
 * Props for the settlement-failed dunning email (BAL-378). `amount` is pre-formatted; `reason`
 * switches between the SCA "confirm your card" recovery and the hard-decline "update your card"
 * copy. Warm, non-adversarial, no "overdraft" — "extra time" is its name.
 */
export interface SessionSettlementFailedEmailProps {
  readonly firstName: string;
  readonly amount: string;
  readonly reason: SettlementFailureReason;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Amber attention pill (needs a small action, but not an alarm). */
const attentionPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(245, 158, 11, 0.18)',
  border: '1px solid rgba(245, 158, 11, 0.35)',
  color: '#FDE68A',
};

/**
 * Settlement-failed dunning email (BAL-378 / ADR-1040 Lane 2) — a warm nudge to the billing
 * admins that a small amount of extra time from a recent session still needs settling. The
 * expert has already been paid; this is only about clearing the card. Gender-neutral.
 */
export function SessionSettlementFailedEmail({
  firstName = 'there',
  amount,
  reason,
  ctaUrl,
  baseUrl,
}: Readonly<SessionSettlementFailedEmailProps>) {
  const needsConfirmation = reason === 'requires_action';
  const heroHeading = needsConfirmation
    ? 'Confirm your card to finish up'
    : "Let's sort the extra time";
  const previewText = needsConfirmation
    ? `Your card needs a quick confirmation to settle ${amount}.`
    : `We couldn't settle ${amount} of extra time — a quick card update sorts it.`;
  const ctaLabel = needsConfirmation ? 'Confirm your card' : 'Update payment';
  const bodyLines = needsConfirmation
    ? [
        `A little extra time ran past your balance on a recent session, and settling ${amount} needs a quick confirmation on your card.`,
        'Confirm it whenever suits — nothing else is on hold.',
      ]
    : [
        `A little extra time ran past your balance on a recent session, and we couldn't settle ${amount} to your card.`,
        'A quick update to your card details sorts it out.',
      ];

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 A quick heads-up" style={attentionPillStyle} />
        <Heading style={shared.smallHeroHeading}>{heroHeading}</Heading>
        <Text style={shared.smallHeroSubtext}>
          Your expert's already taken care of — this is just the card.
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

        <SupportFooter prefix="Questions about this?" />
      </Section>
    </EmailShell>
  );
}
