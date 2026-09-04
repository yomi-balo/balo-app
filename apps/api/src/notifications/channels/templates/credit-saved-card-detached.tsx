import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the saved-card-detached email (BAL-521 §3). All copy is PRE-BRANCHED by the
 * `credit-saved-card-detached` factory in `index.ts` — this component does no branching logic
 * beyond rendering what it is handed, matching the shipped `CreditTopupRequestedEmail` shape.
 */
export interface CreditSavedCardDetachedEmailProps {
  readonly firstName: string;
  /** Pre-branched on `source` — see DEC-8. */
  readonly headline: string;
  /** Pre-branched on `source` + whether the card label is known. */
  readonly leadSentence: string;
  /** '' is tolerated (the guard below still renders correctly) but the shipped
   *  `buildSavedCardDetachedCopy` factory never sends it — even the "already on Just notify
   *  me, so nothing else changed" branch is a sentence, never an empty string. */
  readonly consequence: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/**
 * Calm, INFORMATIONAL pill — a card leaving is a FACT, not a failure (DEC-8). Reuses the same
 * calm primary-toned shape as `CreditTopupRequestedEmail`'s pill, never a warning red.
 */
const infoPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

/**
 * Saved-card-removed notice (BAL-521 §3) — to the company's MANAGE_BILLING holders, from EITHER
 * door: a teammate pressed Remove, or the bank/card provider detached it at Stripe. Warm,
 * factual, gender-neutral, non-adversarial — a card leaving the wallet is a fact to record, not
 * an alarm to raise. No money figure anywhere.
 */
export function CreditSavedCardDetachedEmail({
  firstName = 'there',
  headline,
  leadSentence,
  consequence,
  ctaUrl,
  baseUrl,
}: Readonly<CreditSavedCardDetachedEmailProps>) {
  const previewText = leadSentence;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 Billing update" style={infoPillStyle} />
        <Heading style={shared.smallHeroHeading}>{headline}</Heading>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{leadSentence}</Text>
        {consequence.length > 0 && <Text style={shared.bodyText}>{consequence}</Text>}

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            Manage billing settings →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about billing?" />
      </Section>
    </EmailShell>
  );
}
