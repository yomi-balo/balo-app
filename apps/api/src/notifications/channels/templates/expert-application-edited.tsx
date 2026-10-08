import { Button, Heading, Section, Text } from '@react-email/components';
import type { ExpertApplicationEditSection } from '@balo/shared/experts';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

// BAL-593 — PRIMARY/INFO tone (blue), deliberately NOT the green `approvedPillStyle` and NOT the
// muted `declinedPillStyle` on `expert-application-declined.tsx`: an edit is neither a decision
// nor a failure, it's informational. Mirrors `infoPillStyle` on `billing-email-changed.tsx` /
// `credit-saved-card-detached.tsx` / `party-domain-join.tsx`.
const editedPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

/**
 * BAL-593 — EVERY SENTENCE OF THE BODY IS AN EXPORTED CONSTANT, following the
 * `EXPERT_APPLICATION_DECLINED_COPY` precedent (BAL-549 W1): a whole-string assertion in
 * `expert-application-edited.test.ts` catches a copy edit landing silently, where a
 * `stringContaining` fragment would not.
 *
 * Every line is pending-MJ copy review, gender-neutral, warm, and names no staff member —
 * retrospective attribution for a Balo-staff action goes to the PARTY ("Balo"/"our team"), never
 * the individual reviewer (CLAUDE.md). No numbers: the email states WHICH parts of the profile
 * changed, never a count or a before/after value — those live on the profile itself.
 */
export const EXPERT_APPLICATION_EDITED_COPY = {
  heroSubtext: 'A quick update on your expert profile.',
  intro: 'After reviewing your application, our team updated these parts of your expert profile:',
  liveNote: 'These updates are already live — search and your public profile reflect them now.',
  supportPrefix: "Think something's not right?",
} as const;

/**
 * The four edit-section labels, in `EXPERT_APPLICATION_EDIT_SECTIONS` display order — the ONE
 * definition shared with the admin edit form and the `admin_applications_edited` analytics
 * property's display, though this template only ever reads it keyed by section.
 */
export const EXPERT_APPLICATION_EDIT_SECTION_LABEL: Record<ExpertApplicationEditSection, string> = {
  ratings: 'Skill ratings',
  products: 'Products',
  certifications: 'Certifications',
  experience: 'Experience',
};

// ── Template ─────────────────────────────────────────────────────

interface ExpertApplicationEditedEmailProps {
  readonly firstName: string;
  /**
   * Already filtered to known values, in `EXPERT_APPLICATION_EDIT_SECTIONS` order
   * (`readExpertApplicationEditSections`). The publish schema requires at least one; an empty
   * array degrades to no bullet rows rather than throwing.
   */
  readonly sections: ExpertApplicationEditSection[];
  readonly baseUrl: string;
}

/**
 * BAL-593 — Balo staff edited an `approved` expert application and changed something (a
 * `no_changes` planner result never publishes, so this template never renders for an edit that
 * changed nothing). Lists WHICH sections changed, never the old/new values — those are staff-only
 * audit detail, not applicant-facing copy. Warm and non-adversarial (CLAUDE.md): this is routine
 * upkeep, not a verdict.
 */
export function ExpertApplicationEditedEmail({
  firstName = 'there',
  sections,
  baseUrl,
}: Readonly<ExpertApplicationEditedEmailProps>) {
  const previewText = `Balo updated your expertise, ${firstName}.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Profile update" style={editedPillStyle} />
        <Heading style={shared.smallHeroHeading}>Balo updated your expertise, {firstName}.</Heading>
        <Text style={shared.smallHeroSubtext}>{EXPERT_APPLICATION_EDITED_COPY.heroSubtext}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{EXPERT_APPLICATION_EDITED_COPY.intro}</Text>

        <Section style={{ margin: '0 0 18px' }}>
          {sections.map((section) => (
            <Text key={section} style={{ ...shared.bodyText, margin: '0 0 6px' }}>
              {`• ${EXPERT_APPLICATION_EDIT_SECTION_LABEL[section]}`}
            </Text>
          ))}
        </Section>

        <Text style={shared.bodyText}>{EXPERT_APPLICATION_EDITED_COPY.liveNote}</Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/expert/settings`}>
            Review your profile →
          </Button>
        </Section>

        <SupportFooter prefix={EXPERT_APPLICATION_EDITED_COPY.supportPrefix} />
      </Section>
    </EmailShell>
  );
}
