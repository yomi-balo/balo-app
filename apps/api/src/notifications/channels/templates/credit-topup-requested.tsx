import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the top-up nudge email (BAL-377 / BAL-381). A company member without
 * MANAGE_BILLING asked the billing holder(s) to top up. `memberName` is the nudging
 * member's display name (context in the body); the recipient's own first name arrives as
 * `firstName` (email adapter `recipientName`, resolved per fanned-out billing admin).
 */
export interface CreditTopupRequestedEmailProps {
  readonly firstName: string;
  readonly memberName: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Calm, primary-toned pill — a low-friction prompt, never urgent. */
const promptPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

/**
 * Top-up nudge email (BAL-377 / BAL-381) — a teammate who can spend the shared balance but
 * can't top it up has asked you (a MANAGE_BILLING holder) to add credit. Warm, low-friction,
 * gender-neutral: it names who asked, states what they need, and offers a one-click way to
 * top up. Not adversarial, not a countdown.
 */
export function CreditTopupRequestedEmail({
  firstName = 'there',
  memberName,
  ctaUrl,
  baseUrl,
}: Readonly<CreditTopupRequestedEmailProps>) {
  const previewText = `${memberName} asked you to top up your team's Balo balance.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="🔔 A nudge from your team" style={promptPillStyle} />
        <Heading style={shared.smallHeroHeading}>{memberName} asked for a top-up</Heading>
        <Text style={shared.smallHeroSubtext}>A quick top-up keeps your team moving.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {memberName} let you know that your team&apos;s Balo balance could use a top-up so they
          can keep working with an expert. Whenever it suits you, you can add credit in a few taps.
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            Top up your balance →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about billing?" />
      </Section>
    </EmailShell>
  );
}
