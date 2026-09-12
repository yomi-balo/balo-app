import { Heading, Section, Text } from '@react-email/components';
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

/**
 * BAL-549 WEB-REVIEW FIX ROUND (W1) — EVERY SENTENCE OF THE BODY IS AN EXPORTED CONSTANT.
 *
 * This email is the one surface that told a declined applicant what happens next, and what it
 * told them was untrue (see the template docblock). A `stringContaining` assertion on a fragment
 * cannot catch a promise creeping back in; pinning the FULL literal can. Every string below is
 * asserted verbatim in `expert-application-declined.test.ts`, so a copy edit has to be made
 * deliberately, in two places, by someone who reads the ruling.
 *
 * Every line is pending-MJ copy review, gender-neutral, and warm but non-adversarial (CLAUDE.md).
 */
export const EXPERT_APPLICATION_DECLINED_COPY = {
  heroSubtext: "We're not able to approve your application this time.",
  calloutHeading: "This isn't the end of the road",
  calloutText:
    'Experience, certifications and the mix of work clients ask us for all move over time. If yours change, we would like to hear about it — a person on our team reads every reply.',
  standing:
    'Nothing further is needed from you, and your Balo account stays exactly as it is — you can keep using Balo to find experts of your own whenever you need one.',
  supportPrefix: 'Want to talk it through?',
} as const;

/**
 * The lead paragraph, which is the ONE place the decline reason CATEGORY appears. A function so
 * the whole sentence — reason included — is pinnable verbatim rather than assembled inside JSX.
 */
export function declinedLeadParagraph(reasonLabel: string): string {
  // pending-MJ
  return `Thanks for taking the time to apply. Our team has reviewed your application, and we're not able to approve it this time — ${reasonLabel}.`;
}

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
 * ⚠⚠ THIS EMAIL MUST NOT PROMISE A RE-APPLICATION (WEB-REVIEW FIX ROUND, W1 — user-ruled).
 * It used to: it said the application was "saved, so you won't start from scratch", carried a
 * 🔄 "You can apply again" callout, and a CTA button reading "Apply again when you're ready →".
 * NONE OF THAT WORKED. `expertsRepository.submitApplication`'s WHERE is
 * `applicationStatus = 'draft'`, so a `rejected` profile matches no row and the submit fails —
 * BAL-549's own "Out of scope" excluded the `rejected → submitted` transition, so the copy
 * described a flow that was never built. It now names only what is true today: the decision, the
 * reason category, that nothing more is needed, and the support channel. A FOLLOW-UP TICKET owns
 * the real transition; when that ships, this copy may invite a re-application again — and not one
 * day sooner.
 *
 * ⚠ THERE IS DELIBERATELY NO CTA BUTTON. Linking `/expert/apply` was the actionable half of the
 * false promise (the wizard renders for a `rejected` applicant, then refuses at submit), and
 * linking `docs/help/what-happens-after-you-apply.md` is impossible — that doc is unrouted plain
 * Markdown with no page under `apps/web`, so a `/help/...` href would 404 in production. The
 * `SupportFooter`'s "reply to this email or reach us at support@getbalo.com" is the one action,
 * and it is a channel that genuinely exists.
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
        <Text style={shared.smallHeroSubtext}>{EXPERT_APPLICATION_DECLINED_COPY.heroSubtext}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{declinedLeadParagraph(reasonLabel)}</Text>

        <Callout
          emoji="💬"
          heading={EXPERT_APPLICATION_DECLINED_COPY.calloutHeading}
          text={EXPERT_APPLICATION_DECLINED_COPY.calloutText}
          bg={colors.primaryLight}
          borderColor={colors.primaryBorder}
          headingColor={colors.primary}
        />

        <Text style={shared.bodyText}>{EXPERT_APPLICATION_DECLINED_COPY.standing}</Text>

        <SupportFooter prefix={EXPERT_APPLICATION_DECLINED_COPY.supportPrefix} />
      </Section>
    </EmailShell>
  );
}
