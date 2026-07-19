import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter, Callout } from './shared.js';

/**
 * Props for the top-up receipt email (BAL-377). `credited` / `charged` / `promoBonus` /
 * `balanceAfter` are pre-formatted display strings (the factory formats the raw minor units +
 * ISO expiry via `credit-format`); the recipient's own first name arrives as `firstName`
 * (email adapter `recipientName`). `charged` is shown ONLY when it differs from `credited`
 * (a non-AUD card), so an AUD-card buyer isn't shown "A$X → A$X". NO fee figure anywhere
 * (BAL-357): a top-up buys AUD at face value — the fee lives in the per-minute consume rate.
 */
export interface CreditTopupCompletedEmailProps {
  readonly firstName: string;
  readonly credited: string;
  readonly charged: string;
  /** True when `charged` is a different currency/amount than `credited` (non-AUD card). */
  readonly showCharged: boolean;
  readonly promoBonus: string | null;
  readonly balanceAfter: string;
  readonly expiryDate: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Warm, success-toned pill — the money landed; congratulatory, never an alarm. */
const successPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(16, 185, 129, 0.16)',
  border: '1px solid rgba(16, 185, 129, 0.32)',
  color: '#6EE7B7',
};

/**
 * Top-up receipt email (BAL-377 / ADR-1040 Lane 1) — a warm, factual confirmation that a
 * top-up charged successfully and the balance is ready to spend. Voice matches the
 * dormancy-reminder family: first-name greeting, plain verbs, gender-neutral, and the
 * rolling expiry framed as REASSURANCE ("stays active until {date} — any activity keeps it
 * going"), never a countdown. A promo bonus (when present) is celebrated as extra credit.
 * The primary action is to put the balance to use (find an expert). No fee, no Stripe
 * references (fee-concealment posture).
 */
export function CreditTopupCompletedEmail({
  firstName = 'there',
  credited,
  charged,
  showCharged,
  promoBonus,
  balanceAfter,
  expiryDate,
  ctaUrl,
  baseUrl,
}: Readonly<CreditTopupCompletedEmailProps>) {
  const previewText = `You're topped up — ${balanceAfter} is ready to spend.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 Payment confirmed" style={successPillStyle} />
        <Heading style={shared.smallHeroHeading}>You&apos;re topped up</Heading>
        <Text style={shared.smallHeroSubtext}>{balanceAfter} is ready whenever you are.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          Your top-up went through. {credited} of credit has been added to your balance
          {showCharged ? `, charged as ${charged} in your local currency` : ''}.
        </Text>

        {promoBonus && (
          <Callout
            emoji="🎁"
            heading="Bonus credit applied"
            text={`${promoBonus} of promo credit was added on top of your top-up.`}
            bg="rgba(16, 185, 129, 0.10)"
            borderColor="rgba(16, 185, 129, 0.30)"
            headingColor="#059669"
          />
        )}

        <Text style={shared.bodyText}>
          Your balance is now {balanceAfter}. It stays active until {expiryDate} — any consultation
          or top-up keeps it going, so nothing is left hanging.
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            Find an expert →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your balance?" />
      </Section>
    </EmailShell>
  );
}
