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
} from './shared.js';

// ── Match-request-specific styles ────────────────────────────────
const matchPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(255,255,255,0.12)',
  border: '1px solid rgba(255,255,255,0.2)',
  color: 'rgba(255,255,255,0.85)',
};

const projectCardStyle = {
  margin: '24px 0',
  padding: '18px 20px',
  borderRadius: '12px',
  border: `1px solid ${colors.border}`,
  background: colors.bg,
} as const;

const projectLabelStyle = {
  fontSize: '11px',
  fontWeight: '700',
  color: colors.textTertiary,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.07em',
  margin: '0 0 6px',
} as const;

const projectTitleStyle = {
  fontSize: '16px',
  fontWeight: '600',
  color: colors.text,
  margin: 0,
  lineHeight: '1.5',
} as const;

const projectMetaStyle = {
  fontSize: '13px',
  fontWeight: '500',
  color: colors.textSecondary,
  margin: '8px 0 0',
  lineHeight: '1.5',
} as const;

// ── Template ─────────────────────────────────────────────────────

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
        <StatusPill label="🔍 Needs a match" style={matchPillStyle} />
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
          <p style={projectLabelStyle}>Unrouted project</p>
          <p style={projectTitleStyle}>{projectTitle}</p>
          <p style={projectMetaStyle}>From {companyName}</p>
          {summary ? <p style={projectMetaStyle}>{summary}</p> : null}
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
