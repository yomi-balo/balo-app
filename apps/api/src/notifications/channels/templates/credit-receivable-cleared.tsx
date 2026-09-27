import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the receivable-cleared email (BAL-535 / ADR-1040 Amendment 6 §F, copy BAL-474 v2.1).
 * `balanceAfter` is the true final wallet balance, pre-formatted. Every amount is AUD display
 * value — no fee/margin/Stripe reference anywhere (fee-concealment posture), and "overdraft"
 * never appears.
 *
 * ⚠ THERE IS NO CLEARED-AMOUNT FIGURE. The Σ of the cleared receivables' recorded amounts is a
 * stale snapshot — it disagrees with the dunning notice's top-up figure the moment any other
 * ledger entry lands, and it would call a no-show "extra time" — so the notice states no amount
 * but the balance.
 */
export interface CreditReceivableClearedEmailProps {
  /** Optional BY TYPE because the parameter default below is the real fallback — the registry
   * already passes `?? 'there'`, and a required-but-defaulted prop makes that default
   * unreachable from a test. */
  readonly firstName?: string;
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
 * confirmation that the balance now covers what the consultations came to, so the account's soft
 * hold is released. Voice matches the auto-top-up-executed / top-up-receipt family: first-name
 * greeting, plain verbs, gender-neutral, resolution-moment tone. No fee, no Stripe references, no
 * "overdraft", no "extra time".
 *
 * ⚠ EVERY LINE IS TRUE ON ALL FOUR PATHS THAT SEND IT — a cash top-up that covers the balance, a
 * settlement charge that covers the remaining debts, a settlement charge that clears its own
 * session's last open receivable, and the covered-hold correction — because each fires only when
 * no open receivable remains. So the body states no amount other than the balance.
 *
 * ⚠ "It no longer stops new bookings" claims only that the hold is gone. A company with no
 * payment mandate can still need enough credit for its next booking (BAL-478's funding check and
 * the planned-consultation reservation), and the booking panel says so at the time — so the copy
 * never says "nothing else to do" or that a booking will go through.
 */
export function CreditReceivableClearedEmail({
  firstName = 'there',
  balanceAfter,
  ctaUrl,
  baseUrl,
}: Readonly<CreditReceivableClearedEmailProps>): React.JSX.Element {
  const previewText = `That balance is settled — nothing's outstanding on your account.`;

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
          Your balance now covers what your consultations came to, so your account is clear. It no
          longer stops new bookings.
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
