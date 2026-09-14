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

// ── Triage-specific styles (mirrors project-match-requested.tsx) ────────────────
const triagePillStyle = {
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
  margin: '0 0 6px',
} as const;

const projectMetaStyle = {
  fontSize: '13px',
  color: colors.textSecondary,
  margin: '0 0 4px',
} as const;

interface ProjectRequestSubmittedAdminEmailProps {
  readonly projectTitle: string;
  readonly companyName: string;
  readonly baseUrl: string;
  readonly tagCount?: number;
  readonly productCount?: number;
  readonly documentCount?: number;
}

/**
 * Internal/ops email — a buyer submitted a DIRECT request (they chose the expert themselves).
 *
 * ⚠ NOT the same message as `project-match-requested`, and deliberately not a reuse of it: that
 * one says "unrouted brief needs a match", which would be FALSE here. This request already has
 * an expert; what Balo owes it is triage. Both arms land on the same admin board, by different
 * routes, and the copy has to say which.
 *
 * ⚠ Names the COMPANY, never a person — the submitting user is not on the payload and
 * `data.expert` carries an id with no name, so there is nobody to attribute this to without
 * widening the resolver's hydration (which is serialized into every per-channel BullMQ job).
 *
 * ⚠ The CTA points at `/projects?lens=admin`, the real triage board. `project-match-requested`
 * still links to `/admin/project-requests`, which 404s — do not copy that href.
 */
export function ProjectRequestSubmittedAdminEmail({
  projectTitle = 'a new project',
  companyName = 'A client',
  baseUrl,
  tagCount = 0,
  productCount = 0,
  documentCount = 0,
}: Readonly<ProjectRequestSubmittedAdminEmailProps>) {
  const previewText = `New direct request from ${companyName}: ${projectTitle}`;
  const summary = buildSelectionSummary({ tagCount, productCount, documentCount });

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="⚡ Needs triage" style={triagePillStyle} />
        <Heading style={shared.smallHeroHeading}>New direct request needs triage.</Heading>
        <Text style={shared.smallHeroSubtext}>
          A client submitted a project and chose their own expert.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi team,</Text>
        <Text style={shared.bodyText}>
          {companyName} submitted a project brief directly to an expert. The expert has been
          notified too — this one is on the board so we can keep an eye on it while it moves.
        </Text>

        {/* Project summary */}
        <Section style={projectCardStyle}>
          <p style={projectLabelStyle}>Direct request</p>
          <p style={projectTitleStyle}>{projectTitle}</p>
          <p style={projectMetaStyle}>From {companyName}</p>
          {summary ? <p style={projectMetaStyle}>{summary}</p> : null}
        </Section>

        <Callout
          emoji="⚡"
          heading="Needs triage"
          text="Open the board to read the brief and triage it. The expert already has it, so this is oversight rather than routing."
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/projects?lens=admin`}>
            Open triage board →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this request?" />
      </Section>
    </EmailShell>
  );
}
