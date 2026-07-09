import { Hr, Section, Text } from '@react-email/components';
import {
  reviewStyles,
  windowBlockStyle,
  windowKickerStyle,
  windowHeadlineStyle,
  windowTextStyle,
  ReviewEmailLayout,
  DualCta,
  milestonePhrases,
} from './review-email-shared.js';

/**
 * BAL-338 (D7) — `ReviewReminderEmail` (VARIANT 2 of the project-review email
 * family), sent to the CLIENT company owner at T−2 days when a `pending_acceptance`
 * engagement nears its auto-accept date with no client decision. Implemented VERBATIM
 * (layout AND copy) from `.claude/design-references/email-project-review.jsx`
 * VARIANT 2 — one friendly nudge (the copy promises exactly one). Shares the review
 * shell/tokens/window-block with VARIANT 1/3 (review-email-shared.tsx).
 *
 * TONE (BAL-329, binding): a warm nudge, never a countdown threat — the auto-accept
 * date + "closed out as delivered so nothing stalls" consequence stay unmissable in
 * the window block. Prospective copy names the PARTY (`clientCompany`/`expertParty`).
 * All dates pre-formatted UTC. `milestonesTotal` reads naturally at 0/1/N (retainer
 * seam); `daysLeft` is pluralised so it never renders "1 days".
 */
export interface ReviewReminderEmailProps {
  readonly firstName: string;
  readonly clientCompany: string;
  readonly expertParty: string;
  readonly projectTitle: string;
  readonly milestonesTotal: number;
  readonly requestedDate: string;
  readonly autoDate: string;
  readonly daysLeft: number;
  readonly engagementUrl: string;
}

/**
 * VARIANT 2 — Review reminder, T−2 days (engagement.review_reminder).
 * Subject: "Your completed project is waiting — {projectTitle}"
 */
export function ReviewReminderEmail({
  firstName = 'there',
  clientCompany = 'your team',
  expertParty = 'Your expert',
  projectTitle = 'your project',
  milestonesTotal = 0,
  requestedDate,
  autoDate,
  daysLeft = 2,
  engagementUrl,
}: Readonly<ReviewReminderEmailProps>) {
  const phrases = milestonePhrases(milestonesTotal);
  const daysLabel = daysLeft === 1 ? 'day' : 'days';
  return (
    <ReviewEmailLayout
      preview={`A friendly nudge: ${projectTitle} is delivered and waiting for your look. It wraps up as delivered on ${autoDate}.`}
      pill="👋 Friendly nudge"
      heading="Your completed project is waiting"
      subtext={`${projectTitle} wraps up on ${autoDate} — a couple of minutes now makes it official.`}
    >
      <Text style={reviewStyles.greeting}>Hi {firstName},</Text>
      <Text style={reviewStyles.bodyText}>
        Just a friendly nudge — {expertParty} delivered <strong>{projectTitle}</strong> on{' '}
        {requestedDate}, and it&apos;s been waiting for {clientCompany}&apos;s look since.{' '}
        {phrases.doneClause === '' ? '' : `${phrases.doneClause}; `}the finish line is a click away.
      </Text>

      <Section style={windowBlockStyle('warning')}>
        <p style={windowKickerStyle('warning')}>Wrapping up soon</p>
        <p style={windowHeadlineStyle}>{`${daysLeft} ${daysLabel} to go — wraps up ${autoDate}`}</p>
        <p style={windowTextStyle}>
          Accept the project or request changes whenever suits before then. If the date passes,
          we&apos;ll <strong>close it out as delivered automatically</strong> so nothing stalls —
          the review takes just a couple of minutes.
        </p>
      </Section>

      <DualCta engagementUrl={engagementUrl} />

      <Hr style={reviewStyles.divider} />
      <Text style={{ ...reviewStyles.bodyText, fontSize: '13px', margin: 0 }}>
        We keep nudges to just this one. Questions? Just reply to this email.
      </Text>
    </ReviewEmailLayout>
  );
}
