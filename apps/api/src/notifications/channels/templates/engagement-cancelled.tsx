import { Heading, Section, Text } from '@react-email/components';
import { colors, shared, EmailShell, LogoRow, StatusPill, Callout } from './shared.js';

/**
 * BAL-334 (D4) — Balo cancelled the engagement; BOTH the client company owner and
 * the delivering expert are notified (one component serves both rules — the name
 * greeting differs via the per-recipient `firstName`). Bespoke on `EmailShell` (like
 * `engagement-milestone-completed`): a calm, factual notice — the cancellation date
 * plus the recorded reason in its own styled block. Copy is verbatim ticket copy; no
 * decision CTA (the workspace deep-link lives on the in-app notice).
 */
export interface EngagementCancelledEmailProps {
  readonly firstName: string;
  readonly projectTitle: string;
  readonly cancelledOn: string;
  readonly reason: string;
  readonly baseUrl: string;
}

const cancelledPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(220, 38, 38, 0.16)',
  border: '1px solid rgba(220, 38, 38, 0.32)',
  color: '#FCA5A5',
};

export function EngagementCancelledEmail({
  firstName = 'there',
  projectTitle = 'your project',
  cancelledOn,
  reason,
  baseUrl,
}: Readonly<EngagementCancelledEmailProps>) {
  return (
    <EmailShell previewText={`${projectTitle} has been cancelled`} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Engagement cancelled" style={cancelledPillStyle} />
        <Heading style={shared.smallHeroHeading}>This engagement has been cancelled.</Heading>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{`Balo cancelled the engagement on ${cancelledOn}.`}</Text>

        <Callout
          emoji="📋"
          heading="Reason"
          text={reason}
          bg={colors.bg}
          borderColor={colors.border}
          headingColor={colors.text}
        />

        <Text style={{ ...shared.bodyText, margin: 0 }}>
          Reply to this email or message Balo with any questions.
        </Text>
      </Section>
    </EmailShell>
  );
}
