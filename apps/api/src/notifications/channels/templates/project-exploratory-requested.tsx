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

// ── Exploratory-request-specific styles ──────────────────────────
const exploratoryPillStyle = {
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

interface ProjectExploratoryRequestedEmailProps {
  readonly firstName: string;
  readonly projectTitle: string;
  readonly projectRequestId: string;
  readonly baseUrl: string;
}

/**
 * Client email — Balo wants a quick scoping call before inviting experts. CTA
 * links straight to the request-detail page, where the "Book exploratory call"
 * CTA lives.
 */
export function ProjectExploratoryRequestedEmail({
  firstName = 'there',
  projectTitle = 'your project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectExploratoryRequestedEmailProps>) {
  const previewText = `${firstName}, let's scope ${projectTitle} on a quick call`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="📞 Quick call" style={exploratoryPillStyle} />
        <Heading style={shared.smallHeroHeading}>Balo wants a quick scoping call.</Heading>
        <Text style={shared.smallHeroSubtext}>A 20-minute call helps us match you precisely.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          Before we invite experts, we&apos;d like a short exploratory call to sharpen the scope of
          your project. It takes about 20 minutes and means the specialists we line up are the right
          fit from day one.
        </Text>

        {/* Project summary */}
        <Section style={projectCardStyle}>
          <p style={projectLabelStyle}>Your project</p>
          <p style={projectTitleStyle}>{projectTitle}</p>
        </Section>

        <Callout
          emoji="💡"
          heading="What happens next"
          text="Open your request and pick a time that suits you. After the call, we'll invite the experts best suited to your scope."
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/projects/${projectRequestId}`}>
            Book your call →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your project?" />
      </Section>
    </EmailShell>
  );
}
