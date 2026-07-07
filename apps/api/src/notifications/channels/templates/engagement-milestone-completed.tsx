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
 * BAL-332 (D2) — the delivering expert marked a milestone complete on a live
 * engagement; the client company owner is notified. Bespoke on `EmailShell` (NOT
 * `ProjectStatusEmail`, whose CTA href is hardwired to `/projects/{id}`): this email's
 * CTA deep-links to the delivery workspace `/engagements/{id}`. When the expert
 * captured a delivery note it renders VERBATIM in a success-tinted `Callout` (an
 * escaped React text node) — the trust artifact the client reviews against.
 */
export interface EngagementMilestoneCompletedClientEmailProps {
  readonly firstName: string;
  readonly actorExpertLabel: string;
  readonly milestoneTitle: string;
  readonly completedOn: string;
  readonly completionNote?: string;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly engagementId: string;
  readonly baseUrl: string;
}

const completedPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(5, 150, 105, 0.18)',
  border: '1px solid rgba(5, 150, 105, 0.35)',
  color: '#A7F3D0',
};

export function EngagementMilestoneCompletedClientEmail({
  firstName = 'there',
  actorExpertLabel = 'Your expert',
  milestoneTitle = 'a milestone',
  completedOn,
  completionNote,
  completedCount,
  totalCount,
  engagementId,
  baseUrl,
}: Readonly<EngagementMilestoneCompletedClientEmailProps>) {
  const hasNote = typeof completionNote === 'string' && completionNote.trim() !== '';
  const progressLine = `${completedCount} of ${totalCount} milestones are now complete.`;
  return (
    <EmailShell
      previewText={`${actorExpertLabel} marked '${milestoneTitle}' complete`}
      baseUrl={baseUrl}
    >
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="✓ Milestone completed" style={completedPillStyle} />
        <Heading style={shared.smallHeroHeading}>A milestone is delivered.</Heading>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {`${actorExpertLabel} marked '${milestoneTitle}' complete on ${completedOn}.`}
        </Text>

        {hasNote && (
          <Callout
            emoji="📦"
            heading="Delivered"
            text={completionNote as string}
            bg={colors.successLight}
            borderColor={colors.successBorder}
            headingColor={colors.success}
          />
        )}

        <Text style={shared.bodyText}>{progressLine}</Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/engagements/${engagementId}`}>
            View the delivery plan →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this delivery?" />
      </Section>
    </EmailShell>
  );
}
