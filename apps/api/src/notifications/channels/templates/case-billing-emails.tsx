import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * BAL-399 (ADR-1040 / ADR-1043) — the shared "small receipt" email used by BOTH Case
 * billing-slice notices (`payment.charged` member receipt, `payout.recorded` expert earnings).
 * ONE parameterized component so the two receipts never duplicate their scaffold (SonarCloud
 * new-code duplication gate). Fee concealment is at the CALL SITE: each template passes only its
 * OWN-side figure in `bodyLines` — the member receipt never carries an expert figure, the expert
 * notice never carries the client charge/markup/margin.
 */

/**
 * The pill accent: a calm primary receipt, a success earnings-assurance, or — BAL-410 — a
 * NEUTRAL `muted` for an event that is neither good news nor bad. A cancellation is a plain
 * fact; rendering it `primary` would give it brand emphasis it has not earned, and `success`
 * would celebrate it. There is deliberately NO destructive/red tone: a free cancellation is not
 * an error, and colouring it as one is exactly the adversarial framing the copy rules forbid.
 */
export type CaseBillingReceiptTone = 'primary' | 'success' | 'muted';

export interface CaseBillingReceiptEmailProps {
  readonly firstName: string;
  readonly previewText: string;
  readonly pillLabel: string;
  readonly pillTone: CaseBillingReceiptTone;
  readonly heading: string;
  readonly subtext: string;
  /** Own-side body lines ONLY — the counterparty figure is never passed here. */
  readonly bodyLines: readonly string[];
  readonly ctaLabel: string;
  readonly ctaUrl: string;
  readonly footerPrefix: string;
  readonly baseUrl: string;
}

const PILL_STYLES: Record<CaseBillingReceiptTone, Record<string, string>> = {
  primary: {
    ...shared.statusPillBase,
    background: 'rgba(37, 99, 235, 0.18)',
    border: '1px solid rgba(37, 99, 235, 0.35)',
    color: '#BFDBFE',
  },
  success: {
    ...shared.statusPillBase,
    background: 'rgba(18, 153, 107, 0.18)',
    border: '1px solid rgba(18, 153, 107, 0.35)',
    color: '#A7F3D0',
  },
  // BAL-410 — a slate neutral, deliberately the lowest-contrast of the three.
  muted: {
    ...shared.statusPillBase,
    background: 'rgba(148, 163, 184, 0.16)',
    border: '1px solid rgba(148, 163, 184, 0.32)',
    color: '#CBD5E1',
  },
};

/** A warm, retrospective single-figure receipt. Gender-neutral; no urgency, no jargon. */
export function CaseBillingReceiptEmail({
  firstName = 'there',
  previewText,
  pillLabel,
  pillTone,
  heading,
  subtext,
  bodyLines,
  ctaLabel,
  ctaUrl,
  footerPrefix,
  baseUrl,
}: Readonly<CaseBillingReceiptEmailProps>) {
  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label={pillLabel} style={PILL_STYLES[pillTone]} />
        <Heading style={shared.smallHeroHeading}>{heading}</Heading>
        <Text style={shared.smallHeroSubtext}>{subtext}</Text>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        {bodyLines.map((line) => (
          <Text key={line} style={shared.bodyText}>
            {line}
          </Text>
        ))}

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            {ctaLabel}
          </Button>
        </Section>

        <SupportFooter prefix={footerPrefix} />
      </Section>
    </EmailShell>
  );
}
