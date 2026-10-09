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

/**
 * BAL-557 fix round 2 — the re-application block is now the ONE callout. It used to sit next to
 * a separate "this isn't the end of the road" callout (BAL-549's stand-in for the missing
 * re-apply path); now that the path exists, that sentiment folds in here instead of repeating
 * the same idea twice. There is also no CTA button any more — it would land on a disabled button
 * for the whole cooldown — so the dated text itself names the destination ("your apply page").
 * `reapplyText` is used when the payload carries a date (every decline published from here on);
 * `REAPPLY_TEXT_UNDATED` covers a job enqueued before this field existed and queued past deploy
 * — it still reads true, just without a date.
 */
export const REAPPLY_HEADING = "You're welcome to try again"; // pending-MJ

export function reapplyText(reapplyAvailableDate: string): string {
  // pending-MJ — the wait is stated as a helpful fact, never a countdown.
  return (
    `You're welcome to start a new application from ${reapplyAvailableDate} — just head back ` +
    'to your apply page. Your earlier answers stay saved, so you can pick up and update them ' +
    'rather than start from the beginning. Experience, certifications and the mix of work ' +
    'clients ask us for all move over time, so if yours change, we would like to hear about it ' +
    '— a person on our team reads every reply.'
  );
}

export const REAPPLY_TEXT_UNDATED =
  // pending-MJ
  "You're welcome to start a new application once a short wait has passed — just head back to " +
  'your apply page and you will see exactly when it reopens for you. Your earlier answers stay ' +
  'saved, so you can pick up and update them rather than start from the beginning. Experience, ' +
  'certifications and the mix of work clients ask us for all move over time, so if yours ' +
  'change, we would like to hear about it — a person on our team reads every reply.';

// ── Template ─────────────────────────────────────────────────────

interface ExpertApplicationDeclinedEmailProps {
  readonly firstName: string;
  readonly reason: ExpertDeclineReason;
  readonly baseUrl: string;
  /**
   * Pre-formatted (`formatLongUtc`), e.g. "9 Dec 2026" — computed at PUBLISH time from the live
   * `expert_reapply_cooldown_days` platform setting, so this template never reads config. `null`
   * only for a job enqueued before this field existed; every decline published from here on
   * carries a date.
   */
  readonly reapplyAvailableDate: string | null;
}

/**
 * BAL-549 / BAL-557 — the applicant's expert application was declined. Renders the reason
 * CATEGORY only — `expert_profiles.decline_note` is staff-only, never leaves the DB, and is
 * structurally absent from the payload this template reads. Warm and non-adversarial
 * (CLAUDE.md): a decline is a decision, not a rejection of the person.
 *
 * ⚠⚠ BAL-557 RESTORES THE RE-APPLICATION PROMISE THAT BAL-549's WEB-REVIEW FIX ROUND (W1)
 * REMOVED. W1 was correct for its time: `expertsRepository.submitApplication`'s WHERE was
 * `applicationStatus = 'draft'`, so a `rejected` profile matched no row and any re-application
 * copy described a flow that did not exist. BAL-557 BUILDS that flow — `reopenApplication`
 * (`rejected → draft`) behind a runtime-configurable cooldown — so the promise is now true and
 * dated. There is no CTA button — it would land on a disabled `DeclinedApplicationPanel`
 * (apps/web) for the whole cooldown — so the dated text names the destination in words
 * ("your apply page") instead of linking it.
 */
export function ExpertApplicationDeclinedEmail({
  firstName = 'there',
  reason,
  baseUrl,
  reapplyAvailableDate,
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

        <Text style={shared.bodyText}>{EXPERT_APPLICATION_DECLINED_COPY.standing}</Text>

        <Callout
          emoji="🔁"
          heading={REAPPLY_HEADING}
          text={
            reapplyAvailableDate === null ? REAPPLY_TEXT_UNDATED : reapplyText(reapplyAvailableDate)
          }
          bg={colors.successLight}
          borderColor={colors.successBorder}
          headingColor={colors.success}
        />

        <SupportFooter prefix={EXPERT_APPLICATION_DECLINED_COPY.supportPrefix} />
      </Section>
    </EmailShell>
  );
}
