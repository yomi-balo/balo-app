import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * BAL-626 — someone other than a time entry's author edited or removed it; the author is
 * told. Facts only, no blame. The CTA deep-links to the delivery workspace `/engagements/{id}`.
 */
export interface EngagementTimeEntryChangedEmailProps {
  readonly firstName: string;
  readonly actorExpertLabel: string;
  readonly change: 'edited' | 'removed';
  readonly projectTitle: string;
  readonly workedOnLabel: string;
  readonly hoursLabel: string;
  readonly engagementId: string;
  readonly baseUrl: string;
}

const changedPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(217, 119, 6, 0.18)',
  border: '1px solid rgba(217, 119, 6, 0.35)',
  color: '#FDE68A',
};

export function EngagementTimeEntryChangedEmail({
  firstName = 'there',
  actorExpertLabel = 'Someone on your team',
  change,
  projectTitle = 'your project',
  workedOnLabel,
  hoursLabel,
  engagementId,
  baseUrl,
}: Readonly<EngagementTimeEntryChangedEmailProps>) {
  const removed = change === 'removed';
  return (
    <EmailShell
      previewText={`${actorExpertLabel} ${removed ? 'removed' : 'edited'} a time entry of yours`}
      baseUrl={baseUrl}
    >
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label={removed ? 'Entry removed' : 'Entry edited'} style={changedPillStyle} />
        <Heading style={shared.smallHeroHeading}>
          {removed ? 'A time entry was removed.' : 'A time entry was edited.'}
        </Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {`${actorExpertLabel} ${removed ? 'removed' : 'edited'} your ${hoursLabel} entry for ${workedOnLabel} on ${projectTitle}.`}
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/engagements/${engagementId}`}>
            View the time log →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your hours?" />
      </Section>
    </EmailShell>
  );
}
