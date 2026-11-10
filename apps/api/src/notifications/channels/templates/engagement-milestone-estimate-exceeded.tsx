import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * BAL-624 — logged time took a milestone past its estimate on a time-and-materials project;
 * the client company owner is notified. Hours only: this email never states a rate or an
 * amount. The CTA deep-links to the delivery workspace `/engagements/{id}`.
 */
export interface EngagementMilestoneEstimateExceededClientEmailProps {
  readonly firstName: string;
  readonly actorExpertLabel: string;
  readonly milestoneTitle: string;
  readonly loggedHoursLabel: string;
  readonly estimatedHoursLabel: string;
  readonly engagementId: string;
  readonly baseUrl: string;
}

const overEstimatePillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(217, 119, 6, 0.18)',
  border: '1px solid rgba(217, 119, 6, 0.35)',
  color: '#FDE68A',
};

export function EngagementMilestoneEstimateExceededClientEmail({
  firstName = 'there',
  actorExpertLabel = 'Your expert',
  milestoneTitle = 'a milestone',
  loggedHoursLabel,
  estimatedHoursLabel,
  engagementId,
  baseUrl,
}: Readonly<EngagementMilestoneEstimateExceededClientEmailProps>) {
  return (
    <EmailShell previewText={`'${milestoneTitle}' has gone over its estimate`} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Over estimate" style={overEstimatePillStyle} />
        <Heading style={shared.smallHeroHeading}>A milestone has gone over its estimate.</Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {`${actorExpertLabel} has logged ${loggedHoursLabel} against '${milestoneTitle}', over its ${estimatedHoursLabel} estimate. The time log on the milestone shows what the hours went on.`}
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/engagements/${engagementId}`}>
            View the time log →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about the hours?" />
      </Section>
    </EmailShell>
  );
}
