import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the session-settled receipt email (BAL-378). `amount` is pre-formatted (the factory
 * formats `overdraftSettledMinor` via `credit-format`); `hadOverdraft` switches between the
 * "we settled the extra time" receipt and the "wrapped up within your balance" note. The word
 * "overdraft" NEVER appears — "extra time" is its warm name.
 */
export interface SessionSettledEmailProps {
  readonly firstName: string;
  readonly expertName: string;
  readonly amount: string;
  readonly settledOn: string;
  readonly hadOverdraft: boolean;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Calm, primary-toned pill (a receipt, never an alarm). */
const calmPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

/**
 * Session-settled receipt (BAL-378 / ADR-1040 Lane 2) — a warm, retrospective note to the
 * company's billing admins that a consultation wrapped up and (when relevant) the extra time
 * settled to the card. Gender-neutral throughout; no urgency, no jargon.
 */
export function SessionSettledEmail({
  firstName = 'there',
  expertName,
  amount,
  settledOn,
  hadOverdraft,
  ctaUrl,
  baseUrl,
}: Readonly<SessionSettledEmailProps>) {
  const heroHeading = hadOverdraft ? 'Extra time settled' : 'Your session wrapped up';
  const previewText = hadOverdraft
    ? `We settled ${amount} of extra time from your session with ${expertName}.`
    : `Your session with ${expertName} wrapped up within your balance.`;
  const bodyLines = hadOverdraft
    ? [
        `Your session with ${expertName} on ${settledOn} wrapped up.`,
        `A little extra time ran past your balance, so we settled ${amount} to your card — nothing further to do.`,
      ]
    : [
        `Your session with ${expertName} on ${settledOn} wrapped up.`,
        'It stayed within your balance, so there was nothing extra to settle.',
      ];

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 Session settled" style={calmPillStyle} />
        <Heading style={shared.smallHeroHeading}>{heroHeading}</Heading>
        <Text style={shared.smallHeroSubtext}>A quick receipt for your records.</Text>
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
            View billing →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your balance?" />
      </Section>
    </EmailShell>
  );
}
