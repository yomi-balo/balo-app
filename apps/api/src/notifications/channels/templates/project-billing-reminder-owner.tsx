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

/** Which side of the billing reminder this email addresses (BAL-324). */
export type BillingReminderRole = 'owner' | 'creator';

/**
 * Shared props for the billing-reminder emails (BAL-324). Names are deliberately
 * NOT carried in the payload: the notification resolver does not hydrate the
 * owner/creator user for this event, so counterpart names are unavailable — the
 * copy is anchored on `companyName` + `projectTitle` instead (the recipient's own
 * first name arrives via the email adapter's `recipientName`, greeted below).
 */
export interface ProjectBillingReminderEmailProps {
  readonly firstName: string;
  readonly companyName: string;
  readonly projectTitle: string;
  readonly projectRequestId: string;
  readonly baseUrl: string;
}

const actionPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

const waitingPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(124, 58, 237, 0.18)',
  border: '1px solid rgba(124, 58, 237, 0.35)',
  color: '#DDD6FE',
};

/**
 * Billing-reminder email (BAL-324) — an admin nudged the client to complete their
 * company billing details while the kickoff `client_billing` gate is outstanding.
 * One layout, parameterised by `role`, so the owner and creator variants share the
 * shell and stay in lockstep; only the copy — and the OWNER's action button —
 * vary. Bespoke on `EmailShell` (NOT `ProjectStatusEmail`, whose CTA href is
 * hardwired and always renders): the creator variant is a no-CTA FYI.
 */
export function ProjectBillingReminderEmail({
  role,
  firstName = 'there',
  companyName = 'your company',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectBillingReminderEmailProps & { readonly role: BillingReminderRole }>) {
  const copy =
    role === 'owner'
      ? {
          previewText: `${firstName}, complete your billing details to kick off ${projectTitle}`,
          pillLabel: '💳 Action needed',
          pillStyle: actionPillStyle,
          heroHeading: 'Complete your billing details',
          heroSubtext: 'A proposal has been approved — one step left before kickoff.',
          bodyText: `A project proposal for ${companyName} has been approved and is ready to kick off. To move forward, we need your company's billing details on file.`,
          calloutHeading: 'What happens next',
          calloutText:
            "Add your billing details and we'll settle the upfront invoice — then your expert can begin. It only takes a minute.",
          supportPrefix: 'Questions about billing?',
        }
      : {
          previewText: `${firstName}, ${companyName}'s billing details are still needed to start ${projectTitle}`,
          pillLabel: '⏳ Waiting on billing',
          pillStyle: waitingPillStyle,
          heroHeading: 'Billing details are still outstanding',
          heroSubtext: 'Your project is approved — it just needs billing details to proceed.',
          bodyText: `The proposal for ${companyName} has been approved, but the company's billing details are still outstanding, so kickoff is on hold. We've emailed your account owner to complete them.`,
          calloutHeading: 'What you can do',
          calloutText:
            "Give your company's account owner a nudge to add the billing details — that's the last step before your expert can begin.",
          supportPrefix: 'Questions about this project?',
        };

  return (
    <EmailShell previewText={copy.previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label={copy.pillLabel} style={copy.pillStyle} />
        <Heading style={shared.smallHeroHeading}>{copy.heroHeading}</Heading>
        <Text style={shared.smallHeroSubtext}>{copy.heroSubtext}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{copy.bodyText}</Text>

        <Callout
          emoji="💡"
          heading={copy.calloutHeading}
          text={copy.calloutText}
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        {/* Only the OWNER can act — they get the CTA; the creator email is a
            no-button FYI. TODO(BAL-323): repoint the CTA to the billing-capture
            route once it lands (interim target is the request-detail page). */}
        {role === 'owner' && (
          <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
            <Button style={shared.smallCtaButton} href={`${baseUrl}/projects/${projectRequestId}`}>
              Complete billing details →
            </Button>
          </Section>
        )}

        <SupportFooter prefix={copy.supportPrefix} />
      </Section>
    </EmailShell>
  );
}

/** Owner-side billing reminder — the party who must add billing details (has CTA). */
export function ProjectBillingReminderOwnerEmail(
  props: Readonly<ProjectBillingReminderEmailProps>
): ReturnType<typeof ProjectBillingReminderEmail> {
  return <ProjectBillingReminderEmail role="owner" {...props} />;
}
