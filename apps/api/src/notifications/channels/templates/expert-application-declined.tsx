import { Button, Heading, Section, Text } from '@react-email/components';
import type { ExpertDeclineReason } from '@balo/shared/experts';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
} from './shared.js';
import { EXPERT_DECLINE_REASON_LABEL } from './expert-decline-reason-label.js';

// BAL-549 — a MUTED/SLATE pill, deliberately NOT the green `approvedPillStyle` and NOT a
// destructive/error style: a decline is a decision, not a system failure.
const declinedPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(148, 163, 184, 0.16)',
  border: `1px solid ${colors.border}`,
  color: colors.textSecondary,
};

// ── Template ─────────────────────────────────────────────────────

interface ExpertApplicationDeclinedEmailProps {
  readonly firstName: string;
  readonly reason: ExpertDeclineReason;
  readonly baseUrl: string;
}

/**
 * BAL-549 — the applicant's expert application was declined. Renders the reason CATEGORY only —
 * `expert_profiles.decline_note` is staff-only, never leaves the DB, and is structurally absent
 * from the payload this template reads. Warm and non-adversarial (CLAUDE.md): a decline is a
 * decision, not a rejection of the person.
 *
 * ⚠⚠ DOES NOT LINK TO `docs/help/what-happens-after-you-apply.md` — that doc is unrouted plain
 * Markdown with no page under `apps/web`; a `/help/...` href here would 404 in production. The
 * CTA points at `/expert/apply` instead, which the shipped review-page redirect already honours
 * for a `rejected` applicant.
 */
export function ExpertApplicationDeclinedEmail({
  firstName = 'there',
  reason,
  baseUrl,
}: Readonly<ExpertApplicationDeclinedEmailProps>) {
  const reasonLabel = EXPERT_DECLINE_REASON_LABEL[reason];
  const previewText = `An update on your Balo expert application, ${firstName}.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Application update" style={declinedPillStyle} />
        <Heading style={shared.smallHeroHeading}>Thanks for applying, {firstName}.</Heading>
        <Text style={shared.smallHeroSubtext}>
          We're not able to approve your application this time.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          Thanks for taking the time to apply. Our team has reviewed your application, and we're not
          able to approve it this time — {reasonLabel}.
        </Text>
        <Text style={shared.bodyText}>
          This isn't the end of the road. You're welcome to apply again once things have moved on —
          your application is saved, so you won't start from scratch.
        </Text>

        <Callout
          emoji="🔄"
          heading="You can apply again"
          text="When your experience, credentials, or availability have moved on, come back and pick up right where you left off."
          bg={colors.primaryLight}
          borderColor={colors.primaryBorder}
          headingColor={colors.primary}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/expert/apply`}>
            Apply again when you're ready →
          </Button>
        </Section>

        <SupportFooter />
      </Section>
    </EmailShell>
  );
}
