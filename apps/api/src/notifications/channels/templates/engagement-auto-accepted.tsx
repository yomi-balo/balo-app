import { Button, Hr, Section, Text } from '@react-email/components';
import {
  reviewStyles,
  windowBlockStyle,
  windowKickerStyle,
  windowHeadlineStyle,
  windowTextStyle,
  ReviewEmailLayout,
  milestonePhrases,
} from './review-email-shared.js';

/**
 * BAL-338 (D7) — `AutoAcceptedEmail` (VARIANT 3 of the project-review email family),
 * sent to the CLIENT company owner when the review window elapses with no decision
 * and the sweep closes the project out as delivered. Implemented VERBATIM (layout AND
 * copy) from `.claude/design-references/email-project-review.jsx` VARIANT 3. Shares
 * the review shell/tokens with VARIANT 1/2 but uses the GREEN (success) window tone.
 *
 * TONE (BAL-329, binding): congratulatory — the project is complete. States plainly
 * that the window ended so it closed out as delivered "just as flagged", then the
 * green "what happens now" block + an escape hatch ("closing the project doesn't
 * close the conversation"). Prospective copy names the PARTY. All dates pre-formatted
 * UTC; `milestonesTotal` reads naturally at 0/1/N (retainer seam).
 */
export interface AutoAcceptedEmailProps {
  readonly firstName: string;
  readonly clientCompany: string;
  readonly expertParty: string;
  readonly projectTitle: string;
  readonly milestonesTotal: number;
  readonly requestedDate: string;
  readonly autoDate: string;
  readonly reviewDays: number;
  readonly engagementUrl: string;
}

/** Capitalise the first character of a non-empty clause (e.g. "all 4 …" → "All 4 …"). */
function capitalizeClause(clause: string): string {
  return clause === '' ? '' : `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
}

/** Long titles overflow the hero — the design falls back to "Your project" past 42 chars. */
const HERO_TITLE_MAX = 42;

/**
 * VARIANT 3 — Auto-accepted (engagement.accepted, method='auto').
 * Subject: "{projectTitle} is complete 🎉"
 */
export function AutoAcceptedEmail({
  firstName = 'there',
  clientCompany = 'your team',
  expertParty = 'Your expert',
  projectTitle = 'your project',
  milestonesTotal = 0,
  requestedDate,
  autoDate,
  reviewDays,
  engagementUrl,
}: Readonly<AutoAcceptedEmailProps>) {
  const phrases = milestonePhrases(milestonesTotal);
  const deliveredAlong = capitalizeClause(phrases.deliveredAlongClause);
  const heroTitle = projectTitle.length > HERO_TITLE_MAX ? 'Your project' : projectTitle;
  return (
    <ReviewEmailLayout
      preview={`${projectTitle} is complete — wrapped up as delivered on ${autoDate} after the review window.`}
      pill="🎉 Project complete"
      heading={`${heroTitle} is complete`}
      subtext={`Wrapped up as delivered after ${clientCompany}'s ${reviewDays}-day review window.`}
    >
      <Text style={reviewStyles.greeting}>Hi {firstName},</Text>
      <Text style={reviewStyles.bodyText}>
        Congratulations — <strong>{projectTitle}</strong> is complete! {clientCompany}&apos;s review
        window wrapped up on {autoDate}, so we closed the project out as delivered, just as flagged
        when {expertParty} sent it over on {requestedDate}.
        {deliveredAlong === '' ? '' : ` ${deliveredAlong}.`}
      </Text>

      <Section style={windowBlockStyle('success')}>
        <p style={windowKickerStyle('success')}>What happens now</p>
        <p style={windowHeadlineStyle}>All wrapped up</p>
        <p style={windowTextStyle}>
          Balo will be in touch about the final invoice. The delivery plan and every delivery note
          stay right where they are in your workspace, whenever you want them.
        </p>
      </Section>

      <Section style={reviewStyles.ctaWrapper}>
        <Button style={reviewStyles.ctaPrimary} href={engagementUrl}>
          View the project →
        </Button>
      </Section>

      <Hr style={reviewStyles.divider} />
      <Text style={{ ...reviewStyles.bodyText, fontSize: '13px', margin: 0 }}>
        Something not quite right with the delivery? Just reply to this email and the Balo team will
        help — closing the project doesn&apos;t close the conversation.
      </Text>
    </ReviewEmailLayout>
  );
}
