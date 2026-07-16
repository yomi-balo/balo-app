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

const sharePillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.16)',
  border: '1px solid rgba(37, 99, 235, 0.34)',
  color: '#93C5FD',
};

const noteBlockStyle = {
  margin: '20px 0',
  padding: '16px 18px',
  borderRadius: '10px',
  background: colors.bg,
  border: `1px solid ${colors.border}`,
} as const;

const noteLabelStyle = {
  fontSize: '11px',
  fontWeight: '700',
  color: colors.textTertiary,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.07em',
  margin: '0 0 6px',
} as const;

const noteTextStyle = {
  fontSize: '14px',
  color: colors.textSecondary,
  margin: 0,
  lineHeight: '1.6',
  whiteSpace: 'pre-wrap' as const,
} as const;

// ── Template ─────────────────────────────────────────────────────

interface ProposalSharedEmailProps {
  readonly sharerName: string;
  readonly sharerOrgLabel: string;
  readonly proposalTitle: string;
  readonly note?: string;
  readonly expiresOn: string;
  readonly viewUrl: string;
}

/**
 * BAL-386 — sent to an EXTERNAL (non-Balo-user) colleague a client member shared a
 * submitted proposal with. There is no user row to hydrate, so the greeting is
 * generic ("Hi there,"). The sharer is named as a retrospective PERSON "@ {org}"
 * (gender-neutral). Expiry is stated as a helpful fact, never a countdown. The ONLY
 * link is the magic-link CTA button — the raw token never appears as copyable text.
 * The attached PDF is already client-priced, so this email carries no expert-facing
 * figures.
 */
export function ProposalSharedEmail({
  sharerName,
  sharerOrgLabel,
  proposalTitle,
  note,
  expiresOn,
  viewUrl,
}: Readonly<ProposalSharedEmailProps>) {
  const sharerLabel = `${sharerName} @ ${sharerOrgLabel}`;
  const previewText = `${sharerLabel} shared the proposal "${proposalTitle}" with you.`;
  const hasNote = typeof note === 'string' && note.trim().length > 0;

  return (
    <EmailShell previewText={previewText} baseUrl={viewUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="📄 Shared with you" style={sharePillStyle} />
        <Heading style={shared.smallHeroHeading}>A proposal to review</Heading>
        <Text style={shared.smallHeroSubtext}>{sharerLabel} shared it with you.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi there,</Text>
        <Text style={shared.bodyText}>
          {sharerLabel} shared the proposal <strong>{proposalTitle}</strong> with you so you can
          take a look. You&apos;ll always see the latest version — open it whenever you&apos;re
          ready.
        </Text>

        {hasNote ? (
          <Section style={noteBlockStyle}>
            <p style={noteLabelStyle}>A note from {sharerName}</p>
            <p style={noteTextStyle}>{note}</p>
          </Section>
        ) : null}

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={viewUrl}>
            View the proposal →
          </Button>
        </Section>

        <Callout
          emoji="🔗"
          heading="About this link"
          text={`This link is just for you and works until ${expiresOn}. A copy of the proposal is attached to this email for your records.`}
          bg={colors.primaryLight}
          borderColor={colors.primaryBorder}
          headingColor={colors.primary}
        />

        <SupportFooter prefix="Questions about this proposal?" />
      </Section>
    </EmailShell>
  );
}
