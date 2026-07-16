import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the balance-expired email (BAL-380). `expiryDate` is a pre-formatted display
 * string (the factory formats the ISO `expiresAt` via `credit-format`); the recipient's
 * own first name arrives as `firstName` (email adapter `recipientName`). NO balance
 * figure — it is 0 post-expiry, so the design shows only the date.
 */
export interface CreditBalanceExpiredEmailProps {
  readonly firstName: string;
  readonly expiryDate: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Soft, neutral pill — no red, no alarm (the copy is provisional pending counsel review). */
const softPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(148, 163, 184, 0.16)',
  border: '1px solid rgba(148, 163, 184, 0.32)',
  color: 'rgba(255,255,255,0.75)',
};

/**
 * Balance-expired email (BAL-380 / ADR-1040 Lane 3) — the wallet reached its rolling
 * expiry date. Deliberately SOFT and provisional (no red, no alarm icon, no urgency):
 * it states the fact plainly, offers a warm way back (add credit + book a consultation),
 * and offers a human ("just reply to this email — a real person will help"). Shows NO
 * balance figure (0 post-expiry). Gender-neutral throughout. The copy is provisional
 * pending the counsel review flagged in ADR-1040 on monetary-balance expiry — keep it
 * gentle.
 */
export function CreditBalanceExpiredEmail({
  firstName = 'there',
  expiryDate,
  ctaUrl,
  baseUrl,
}: Readonly<CreditBalanceExpiredEmailProps>) {
  const previewText = 'About your Balo balance — you can pick back up anytime.';

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero (soft, neutral tone) ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="About your balance" style={softPillStyle} />
        <Heading style={shared.smallHeroHeading}>Your balance reached its expiry date</Heading>
        <Text style={shared.smallHeroSubtext}>You can pick back up whenever it suits you.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>

        <Text style={shared.bodyText}>
          Your Balo balance reached its expiry date on {expiryDate}.
        </Text>

        <Text style={shared.bodyText}>
          If you&apos;d like to pick back up, you can add credit and book a consultation anytime.
          And if you have any questions about your balance, just reply to this email — a real person
          will help.
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            Add credit →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your balance?" />
      </Section>
    </EmailShell>
  );
}
