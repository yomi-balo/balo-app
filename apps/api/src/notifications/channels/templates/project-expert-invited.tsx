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

// ── Expert-invite-specific styles ────────────────────────────────
const invitePillStyle = {
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

// ── Template ─────────────────────────────────────────────────────

interface ProjectExpertInvitedEmailProps {
  readonly firstName: string;
  readonly projectTitle: string;
  readonly projectRequestId: string;
  readonly baseUrl: string;
}

/**
 * Expert email — Balo invited this expert to express interest in a project. CTA
 * links to the request-detail page where the EOI flow (A3) lives.
 */
export function ProjectExpertInvitedEmail({
  firstName = 'there',
  projectTitle = 'a new project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectExpertInvitedEmailProps>) {
  const previewText = `${firstName}, you're invited to a project: ${projectTitle}`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="✨ You're invited" style={invitePillStyle} />
        <Heading style={shared.smallHeroHeading}>You&apos;re invited to a project.</Heading>
        <Text style={shared.smallHeroSubtext}>Balo thinks you&apos;re a strong fit.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          Balo invited you to express interest in a project that matches your expertise. Review the
          brief and, if it&apos;s a fit, send a short expression of interest to start the
          conversation.
        </Text>

        {/* Project summary */}
        <Section style={projectCardStyle}>
          <p style={projectLabelStyle}>Project request</p>
          <p style={projectTitleStyle}>{projectTitle}</p>
        </Section>

        <Callout
          emoji="💡"
          heading="What happens next"
          text="Open the request to read the full brief, then express interest. The faster you respond, the more momentum the conversation has."
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/projects/${projectRequestId}`}>
            View the request →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this invite?" />
      </Section>
    </EmailShell>
  );
}
