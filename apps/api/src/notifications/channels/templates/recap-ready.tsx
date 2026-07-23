import { Button, Heading, Section, Text } from '@react-email/components';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
} from './shared.js';

/**
 * BAL-387 (ADR-1013 + ADR-1043) — a transcript recap is ready; the client company owner OR the
 * delivering expert is notified. ONE component serves both rules — the greeting differs via the
 * per-recipient `firstName`. Bespoke on `EmailShell` (like `action-item-assigned`, NOT
 * `ProjectStatusEmail`): the CTA deep-links to the delivery workspace `/engagements/{id}`. Copy
 * is gender-neutral and carries NO money (fee-safe by construction). `summaryHeadline`, when
 * present, is a short plain-text one-liner of shared meeting context; `actionItemCount` reads as
 * a helpful fact, never a countdown.
 */
export interface RecapReadyEmailProps {
  readonly firstName: string;
  readonly summaryHeadline?: string;
  readonly actionItemCount: number;
  readonly engagementId: string;
  readonly baseUrl: string;
}

const recapPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(5, 150, 105, 0.16)',
  border: '1px solid rgba(5, 150, 105, 0.35)',
  color: '#A7F3D0',
};

/** "1 action item" / "3 action items" / "" when there are none. */
function actionItemLine(count: number): string {
  if (count <= 0) {
    return '';
  }
  return count === 1
    ? '1 action item is ready to review.'
    : `${count} action items are ready to review.`;
}

export function RecapReadyEmail({
  firstName = 'there',
  summaryHeadline,
  actionItemCount,
  engagementId,
  baseUrl,
}: Readonly<RecapReadyEmailProps>) {
  const itemsLine = actionItemLine(actionItemCount);
  const itemsSuffix = itemsLine ? ` ${itemsLine}` : '';
  return (
    <EmailShell previewText="Your session recap is ready" baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Recap ready" style={recapPillStyle} />
        <Heading style={shared.smallHeroHeading}>Your session recap is ready.</Heading>
        <Text style={shared.smallHeroSubtext}>
          A summary and any follow-ups are waiting for you.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {`Your session summary is ready to read.${itemsSuffix}`}
        </Text>

        {summaryHeadline ? (
          <Callout
            emoji="📝"
            heading="Summary"
            text={summaryHeadline}
            bg={colors.bg}
            borderColor={colors.border}
            headingColor={colors.text}
          />
        ) : null}

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/engagements/${engagementId}`}>
            View the recap →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this?" />
      </Section>
    </EmailShell>
  );
}
