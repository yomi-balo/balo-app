import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the receivable-cleared email (BAL-535 / ADR-1040 Amendment 6 §F). `covered` is the
 * pre-formatted AUD amount the CONSULTATIONS' extra time came to; `balanceAfter` is the true
 * final wallet balance. Every amount is AUD display value — no fee/margin/Stripe reference
 * anywhere (fee-concealment posture), and "overdraft" never appears — the vocabulary is "extra
 * time" / "balance", per the copy rules this amendment settles.
 *
 * ⚠ `covered` IS ATTRIBUTED TO THE CONSULTATIONS, NEVER TO THIS PAYMENT (fix round N5/L2). It is
 * the receivable's recorded amount, which `receivable-coverage.ts` itself calls a stale snapshot
 * — it diverges from what is actually owed the moment any other ledger entry lands. "Your top-up
 * covered ($50.00)" was therefore false after a partial top-up that contributed $20. What the
 * figure IS true of is what that extra time came to, so that is what the copy says.
 */
export interface CreditReceivableClearedEmailProps {
  /** Optional BY TYPE because the parameter default below is the real fallback — the registry
   * already passes `?? 'there'`, and a required-but-defaulted prop makes that default
   * unreachable from a test. */
  readonly firstName?: string;
  readonly covered: string;
  readonly balanceAfter: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Warm, success-toned pill — the hold is released; congratulatory, never an alarm. */
const successPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(16, 185, 129, 0.16)',
  border: '1px solid rgba(16, 185, 129, 0.32)',
  color: '#6EE7B7',
};

/**
 * Receivable-cleared email (BAL-535 / ADR-1040 Amendment 6 §F) — a warm, congratulatory
 * confirmation that a top-up covered the extra time still to settle from a recent consultation,
 * so the account's soft hold is released and the team can book again right away. Voice matches
 * the auto-top-up-executed / top-up-receipt family: first-name greeting, plain verbs,
 * gender-neutral, resolution-moment tone. No fee, no Stripe references, no "overdraft".
 */
export function CreditReceivableClearedEmail({
  firstName = 'there',
  covered,
  balanceAfter,
  ctaUrl,
  baseUrl,
}: Readonly<CreditReceivableClearedEmailProps>): React.JSX.Element {
  const previewText = `That balance is settled — you're all set to book again.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="✅ Account clear" style={successPillStyle} />
        <Heading style={shared.smallHeroHeading}>You&apos;re all set</Heading>
        <Text style={shared.smallHeroSubtext}>That balance is settled.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          The extra time still to settle from your recent consultations — {covered} — is now covered
          by your balance, so your account is clear. There&apos;s nothing else to do.
        </Text>
        <Text style={shared.bodyText}>Your balance is now {balanceAfter}.</Text>

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
