import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * BAL-333 (D3) — the delivering expert changed the delivery plan (added / edited /
 * removed a milestone) on a live engagement; the client company owner is notified.
 * Bespoke on `EmailShell` (like `engagement-milestone-completed`, NOT `ProjectStatusEmail`
 * whose CTA href is hardwired to `/projects/{id}`): this email's CTA deep-links to the
 * delivery workspace `/engagements/{id}`. The client is TOLD, not asked — the body states
 * plainly that the project price is unchanged. `changeSummary` is the pre-computed,
 * change-kind-agnostic phrase ("added 'X'" / "revised 'Y'" / "removed 'Z'").
 */
export interface EngagementScopeChangedClientEmailProps {
  readonly firstName: string;
  readonly actorExpertLabel: string;
  readonly changeSummary: string;
  readonly projectTitle: string;
  readonly engagementId: string;
  readonly baseUrl: string;
}

const scopePillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

export function EngagementScopeChangedClientEmail({
  firstName = 'there',
  actorExpertLabel = 'Your expert',
  changeSummary = 'updated a milestone',
  projectTitle = 'your project',
  engagementId,
  baseUrl,
}: Readonly<EngagementScopeChangedClientEmailProps>) {
  return (
    <EmailShell previewText={`${actorExpertLabel} updated the delivery plan`} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Delivery plan updated" style={scopePillStyle} />
        <Heading style={shared.smallHeroHeading}>The delivery plan changed.</Heading>
        <Text style={shared.smallHeroSubtext}>{projectTitle}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {`${actorExpertLabel} updated the delivery plan: ${changeSummary}. The project price is unchanged.`}
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/engagements/${engagementId}`}>
            View the delivery plan →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this change?" />
      </Section>
    </EmailShell>
  );
}
