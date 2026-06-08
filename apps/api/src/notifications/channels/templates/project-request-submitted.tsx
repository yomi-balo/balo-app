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

// ── Project-request-specific styles ──────────────────────────────
const newRequestPillStyle = {
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

const projectSummaryStyle = {
  fontSize: '13px',
  fontWeight: '500',
  color: colors.textSecondary,
  margin: '8px 0 0',
  lineHeight: '1.5',
} as const;

// ── Template ─────────────────────────────────────────────────────

interface ProjectRequestSubmittedEmailProps {
  readonly firstName: string;
  readonly projectTitle: string;
  readonly baseUrl: string;
  readonly tagCount?: number;
  readonly productCount?: number;
  readonly documentCount?: number;
}

export function ProjectRequestSubmittedEmail({
  firstName = 'there',
  projectTitle = 'a new project',
  baseUrl,
  tagCount = 0,
  productCount = 0,
  documentCount = 0,
}: Readonly<ProjectRequestSubmittedEmailProps>) {
  const previewText = `${firstName}, you have a new project request: ${projectTitle}`;
  const summary = buildSelectionSummary({ tagCount, productCount, documentCount });

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="✨ New Request" style={newRequestPillStyle} />
        <Heading style={shared.smallHeroHeading}>
          {firstName}, you have a new project request.
        </Heading>
        <Text style={shared.smallHeroSubtext}>A client wants to work with you.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          A client has sent you a project request through your Balo profile. Review the details and
          reply with a scoped proposal to get the conversation started.
        </Text>

        {/* Project summary */}
        <Section style={projectCardStyle}>
          <p style={projectLabelStyle}>Project request</p>
          <p style={projectTitleStyle}>{projectTitle}</p>
          {summary ? <p style={projectSummaryStyle}>{summary}</p> : null}
        </Section>

        <Callout
          emoji="💡"
          heading="What happens next"
          text="Open your dashboard to read the full brief, then reply with a scoped proposal. The faster you respond, the more likely the client is to move forward."
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/dashboard`}>
            Review request →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this request?" />
      </Section>
    </EmailShell>
  );
}
