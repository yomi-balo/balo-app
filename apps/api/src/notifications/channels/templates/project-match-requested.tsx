import { Button, Heading, Section, Text } from '@react-email/components';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
  buildSelectionSummary,
  heroPillStyle,
  projectCardStyle,
  projectCardLabelStyle,
  projectCardHeadingStyle,
  projectCardMetaStyle,
} from './shared.js';

interface ProjectMatchRequestedEmailProps {
  readonly projectTitle: string;
  readonly companyName: string;
  readonly baseUrl: string;
  readonly tagCount?: number;
  readonly productCount?: number;
  readonly documentCount?: number;
}

/**
 * Internal/ops email — a buyer submitted an UNROUTED brief that needs a manual
 * expert match. Title-only (no HTML body) per the v1 decision; the ops team reads
 * the full brief in-product. Recipient is the configured ops inbox.
 */
export function ProjectMatchRequestedEmail({
  projectTitle = 'a new project',
  companyName = 'A client',
  baseUrl,
  tagCount = 0,
  productCount = 0,
  documentCount = 0,
}: Readonly<ProjectMatchRequestedEmailProps>) {
  const previewText = `New unrouted brief from ${companyName}: ${projectTitle}`;
  const summary = buildSelectionSummary({ tagCount, productCount, documentCount });

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="🔍 Needs a match" style={heroPillStyle} />
        <Heading style={shared.smallHeroHeading}>New unrouted brief needs a match.</Heading>
        <Text style={shared.smallHeroSubtext}>
          A client submitted a project without choosing an expert.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi team,</Text>
        <Text style={shared.bodyText}>
          {companyName} submitted a project brief and asked us to match them with the right expert.
          Review the brief and route it to a suitable specialist.
        </Text>

        {/* Project summary */}
        <Section style={projectCardStyle}>
          <p style={projectCardLabelStyle}>Unrouted project</p>
          <p style={projectCardHeadingStyle}>{projectTitle}</p>
          <p style={projectCardMetaStyle}>From {companyName}</p>
          {summary ? <p style={projectCardMetaStyle}>{summary}</p> : null}
        </Section>

        <Callout
          emoji="⚡"
          heading="Action needed"
          text="Open the ops queue to read the full brief, then match it with an expert. The faster we route it, the better the client experience."
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/admin/project-requests`}>
            Review brief →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this brief?" />
      </Section>
    </EmailShell>
  );
}
