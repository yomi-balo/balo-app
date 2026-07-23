import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the auto-top-up executed email (BAL-379). `reloaded` / `balanceAfter` are
 * pre-formatted display strings (the factory formats the raw minor units + ISO expiry via
 * `credit-format`); the recipient's own first name arrives as `firstName` (email adapter
 * `recipientName`). Every amount is the AUD reload FACE value — NO fee/margin/overdraft
 * figure anywhere (BAL-357 fee-concealment; a reload buys AUD at face value).
 */
export interface CreditAutoTopupExecutedEmailProps {
  readonly firstName: string;
  readonly reloaded: string;
  readonly balanceAfter: string;
  readonly expiryDate: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Warm, success-toned pill — the reload landed; congratulatory, never an alarm. */
const successPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(16, 185, 129, 0.16)',
  border: '1px solid rgba(16, 185, 129, 0.32)',
  color: '#6EE7B7',
};

/**
 * Auto-top-up executed email (BAL-379 / ADR-1040) — a warm, factual confirmation that the team's
 * balance dipped low and was topped up automatically on the saved card, so nothing was
 * interrupted. Voice matches the top-up-receipt / dormancy family: first-name greeting, plain
 * verbs, gender-neutral, and the rolling expiry framed as REASSURANCE ("stays active until
 * {date} — any activity keeps it going"), never a countdown. No fee, no Stripe references, no
 * "overdraft".
 */
export function CreditAutoTopupExecutedEmail({
  firstName = 'there',
  reloaded,
  balanceAfter,
  expiryDate,
  ctaUrl,
  baseUrl,
}: Readonly<CreditAutoTopupExecutedEmailProps>) {
  const previewText = `Auto-top-up added ${reloaded} — your balance is now ${balanceAfter}.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 Auto-top-up complete" style={successPillStyle} />
        <Heading style={shared.smallHeroHeading}>We topped up your balance</Heading>
        <Text style={shared.smallHeroSubtext}>{balanceAfter} is ready, nothing interrupted.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          Your team&apos;s balance was running low, so auto-top-up added {reloaded} on your saved
          card to keep things moving — no action needed.
        </Text>
        <Text style={shared.bodyText}>
          Your balance is now {balanceAfter}.
          {expiryDate
            ? ` It stays active until ${expiryDate} — any consultation or top-up keeps it going, so nothing is left hanging.`
            : ''}
        </Text>

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
