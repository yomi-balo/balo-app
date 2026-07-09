import { Hr, Section, Text } from '@react-email/components';
import {
  reviewStyles,
  windowBlockStyle,
  windowKickerStyle,
  windowHeadlineStyle,
  windowTextStyle,
  ReviewEmailLayout,
  ProjectSummary,
  DualCta,
  milestonePhrases,
} from './review-email-shared.js';

/**
 * BAL-334 (D4) — `CompletionRequestEmail` (VARIANT 1 of the project-review email
 * family), sent to the CLIENT company owner when the delivering expert marks the
 * whole project complete. Implemented VERBATIM (layout AND copy) from the design
 * reference `.claude/design-references/email-project-review.jsx` VARIANT 1. The
 * shared shell/tokens/blocks live in `review-email-shared.tsx`; VARIANT 2
 * (engagement-review-reminder.tsx) and VARIANT 3 (engagement-auto-accepted.tsx) are
 * the BAL-338 siblings that reuse the same shell.
 *
 * TONE (BAL-329, binding): warm + congratulatory — completion is the happiest email
 * a client gets. Celebrate first; the auto-accept date and consequence stay
 * unmissable (the window block) but framed as "we close it out as delivered so
 * nothing stalls", never a deadline threat. Prospective copy names the PARTY
 * (`clientCompany` / `expertParty`); retrospective copy names the PERSON with
 * "@ company/agency" on first mention (`actorExpert`). All dates are pre-formatted
 * UTC strings — no date logic here.
 */

// Re-exported so existing importers (index.ts, engagement-lifecycle.test.ts) keep
// resolving `milestonePhrases` from this module after the shared-shell extraction.
export { milestonePhrases };

export interface CompletionRequestEmailProps {
  readonly firstName: string;
  readonly clientCompany: string;
  readonly expertParty: string;
  readonly actorExpert: string;
  readonly projectTitle: string;
  readonly milestonesTotal: number;
  readonly requestedDate: string;
  readonly autoDate: string;
  readonly reviewDays: number;
  readonly engagementUrl: string;
}

/**
 * VARIANT 1 — Completion request (engagement.completion_requested).
 * Subject: "Great news — {projectTitle} is complete 🎉"
 */
export function CompletionRequestEmail({
  firstName = 'there',
  clientCompany = 'your team',
  expertParty = 'Your expert',
  actorExpert = 'Your expert',
  projectTitle = 'your project',
  milestonesTotal = 0,
  requestedDate,
  autoDate,
  reviewDays,
  engagementUrl,
}: Readonly<CompletionRequestEmailProps>) {
  const phrases = milestonePhrases(milestonesTotal);
  return (
    <ReviewEmailLayout
      preview={`${actorExpert} ${phrases.previewLead}. Take a look and make it official — you have until ${autoDate}.`}
      pill="🎉 Project delivered"
      heading="Your project is complete!"
      subtext={`${expertParty} has ${phrases.subtextLead} — the finishing touch is ${clientCompany}'s.`}
    >
      <Text style={reviewStyles.greeting}>Hi {firstName},</Text>
      <Text style={reviewStyles.bodyText}>
        Great news — {actorExpert} marked <strong>{projectTitle}</strong> complete on{' '}
        {requestedDate}
        {phrases.bodyClause === '' ? '' : `, with ${phrases.bodyClause}`}. Nice work getting this
        over the line together. The last step is yours: take a look and make it official.
      </Text>

      <ProjectSummary
        projectTitle={projectTitle}
        expertParty={expertParty}
        deliveryPlanValue={phrases.planValue}
        requestedDate={requestedDate}
      />

      <Section style={windowBlockStyle('warning')}>
        <p style={windowKickerStyle('warning')}>The final step</p>
        <p style={windowHeadlineStyle}>Take until {autoDate} — no rush</p>
        <p style={windowTextStyle}>
          {clientCompany} has {reviewDays} days to look everything over. Accept the project or
          request changes any time before {autoDate} — and if the date slips by, we&apos;ll{' '}
          <strong>close the project out as delivered automatically</strong>, so nothing is ever left
          hanging.
        </p>
      </Section>

      <DualCta engagementUrl={engagementUrl} />

      <Hr style={reviewStyles.divider} />
      <Text style={{ ...reviewStyles.bodyText, fontSize: '13px', margin: 0 }}>
        Not sure about something in the delivery? Requesting changes sends the project back to{' '}
        {expertParty} with your note — nothing is final until you&apos;re happy or the window
        closes. Questions? Just reply to this email.
      </Text>
    </ReviewEmailLayout>
  );
}
