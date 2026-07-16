import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, colors, EmailShell, LogoRow, SupportFooter } from './shared.js';

// ── Promo-redeemed styles ────────────────────────────────────────
const styles = {
  hero: {
    ...shared.heroBase,
    padding: '36px 40px 32px',
  },
  heroHeading: {
    ...shared.heroHeadingBase,
    fontSize: '24px',
    margin: '14px 0 10px',
    lineHeight: '1.28',
  } as const,
  heroSubtext: {
    ...shared.heroSubtext,
    fontSize: '15px',
    color: 'rgba(255,255,255,0.70)',
  } as const,
  bodyText: {
    ...shared.bodyText,
    margin: '0 0 20px',
  } as const,
  // The granted amount, featured as a large, calm figure (not a countdown / pressure).
  amount: {
    fontSize: '34px',
    fontWeight: '700',
    color: colors.success,
    margin: '0 0 4px',
    lineHeight: '1.1',
    textAlign: 'center' as const,
  } as const,
  amountCaption: {
    fontSize: '13px',
    color: colors.textTertiary,
    margin: '0 0 4px',
    textAlign: 'center' as const,
  } as const,
  balanceCard: {
    backgroundColor: colors.successLight,
    border: `1px solid ${colors.successBorder}`,
    borderRadius: '12px',
    padding: '22px 24px',
    margin: '4px 0 24px',
  } as const,
  ctaButton: {
    ...shared.ctaButton,
    fontSize: '15px',
    padding: '13px 32px',
    letterSpacing: '0.01em',
  } as const,
};

// ── Template ─────────────────────────────────────────────────────

interface PromoRedeemedEmailProps {
  readonly firstName: string;
  readonly code: string;
  readonly grantedLabel: string;
  readonly companyName: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/**
 * BAL-383 (ADR-1040) promo-redeemed confirmation. A warm, congratulatory, gender-neutral
 * milestone acknowledgment of an action the recipient personally took ("You redeemed
 * WELCOME50 — A$50.00 added to {companyName}"). It names the granted amount as a calm
 * fact — NO countdown, NO "spend it before it's gone" pressure. The Model-C hand-off
 * ("add a card when the balance runs out — nothing is charged until then") is stated
 * plainly, not urgently. `firstName` falls back to 'there' for a name-less recipient.
 */
export function PromoRedeemedEmail({
  firstName = 'there',
  code,
  grantedLabel,
  companyName,
  ctaUrl,
  baseUrl,
}: Readonly<PromoRedeemedEmailProps>) {
  const previewText = `${grantedLabel} in Balo credit is ready for ${companyName}.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={styles.hero}>
        <LogoRow />
        <Heading style={styles.heroHeading}>You&apos;re all set 🎉</Heading>
        <Text style={styles.heroSubtext}>Your promo code is redeemed and the credit is ready.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>

        <Text style={styles.bodyText}>
          Thanks for redeeming <strong>{code}</strong>. Here&apos;s what landed in your Balo
          balance:
        </Text>

        {/* Granted amount — the milestone figure */}
        <Section style={styles.balanceCard}>
          <Text style={styles.amountCaption}>Added to {companyName}</Text>
          <Text style={styles.amount}>{grantedLabel}</Text>
        </Section>

        <Text style={styles.bodyText}>
          This is prepaid credit — there&apos;s no card needed and nothing to pay. Put it towards a
          project, a Quick Start, or a live consultation whenever you&apos;re ready.
        </Text>

        <Text style={styles.bodyText}>
          When your promo balance runs out, you can add a card to keep going — no charge until you
          choose to continue.
        </Text>

        {/* CTA */}
        <Section style={{ ...shared.ctaWrapper, margin: '32px 0 28px' }}>
          <Button style={styles.ctaButton} href={ctaUrl}>
            Find an expert →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your credit?" />
      </Section>
    </EmailShell>
  );
}
