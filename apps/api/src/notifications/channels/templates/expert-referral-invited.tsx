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

const invitePillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(124, 58, 237, 0.18)',
  border: '1px solid rgba(124, 58, 237, 0.35)',
  color: '#C4B5FD',
};

// ── Template ─────────────────────────────────────────────────────

interface ExpertReferralInvitedEmailProps {
  readonly inviterName: string;
  readonly applyUrl: string;
}

/**
 * BAL-325 — sent to an EXTERNAL (non-Balo-user) address a Balo expert referred
 * on the /expert/apply/success page. There is no user row to hydrate, so the
 * greeting is generic ("Hi there,") and never relies on `recipientName`. Only
 * `inviterName` (from the event payload) and the apply CTA vary.
 */
export function ExpertReferralInvitedEmail({
  inviterName = 'A colleague',
  applyUrl,
}: Readonly<ExpertReferralInvitedEmailProps>) {
  const previewText = `${inviterName} thinks you'd be a great fit for Balo's expert network.`;

  return (
    <EmailShell previewText={previewText} baseUrl={applyUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="✨ You're invited" style={invitePillStyle} />
        <Heading style={shared.smallHeroHeading}>Join Balo as an expert</Heading>
        <Text style={shared.smallHeroSubtext}>{inviterName} thinks you&apos;d be a great fit.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi there,</Text>
        <Text style={shared.bodyText}>
          {inviterName} thinks you&apos;d be a great fit for Balo — a marketplace that connects
          Salesforce experts with businesses that need their help. They invited you to apply and
          join the network.
        </Text>
        <Text style={shared.bodyText}>
          Set your own rates, choose the work you take on, and get matched with clients who need
          your expertise. Applying takes just a few minutes.
        </Text>

        <Callout
          emoji="🚀"
          heading="Why join Balo"
          text="Curated client requests, flexible engagements (per-minute cases, custom projects, and productized packages), and fast payouts — all in one place."
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={applyUrl}>
            Apply to Balo →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this invite?" />
      </Section>
    </EmailShell>
  );
}
