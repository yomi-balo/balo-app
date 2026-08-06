import { Hr, Link, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import { consultationClause, ReviewEmailLayout, reviewStyles } from './review-email-shared.js';
import { ReviewAskBlock } from './review-ask-block.js';

/**
 * BAL-390 — `ReviewNudgeEmail`, the star-rating nudge published by the API's hourly
 * review-nudge sweep at +24h and +7d off the terminal anchor (`accepted_at` for a
 * project, `closed_at` for a case). ONE component; `cadenceStep` drives the copy.
 *
 * ⚠ NOT `engagement-review-reminder-client`. THAT template is BAL-338/D7's T-2
 * "review the delivered work before it auto-accepts" nudge and must not be touched or
 * consolidated with this one. Different event, payload, meaning and template.
 *
 * ⚠ THERE IS NO STEP 3, AND THERE CANNOT BE ONE — the sweep's band math makes an
 * anchor older than 7d+1h unmatchable forever, with no schema state and no
 * cancellation code. That is what makes BOTH terminal promises below literally true:
 *   step 1 → "We'll ask once more and then leave it there."
 *   step 2 → "That's the last time we'll ask about this one — no more reminders
 *             either way."
 * Do not soften, requalify or delete either line without changing the sweep.
 *
 * TONE (BAL-329 + BAL-390-DESIGN): step 1 is a light touch while recall is fresh —
 * it reminds, it does not reground. Step 2 can land 37+ days after the last
 * consultation, so it LEADS with the regrounding (what / who / when / how many / why
 * it arrived so late) BEFORE asking anything: a bare "how did it go?" gets deleted not
 * from reluctance but because the recipient genuinely cannot place it. Prospective
 * copy names the PARTY (`expertParty`). Dates are pre-formatted UTC strings.
 *
 * All copy is DRAFT pending MJ sign-off. Gender-neutral throughout.
 */
export interface ReviewNudgeEmailProps {
  readonly firstName: string;
  /** 1 = +24h light touch · 2 = +7d regrounded last ask. There is no 3. */
  readonly cadenceStep: 1 | 2;
  readonly engagementKind: 'project' | 'case';
  readonly engagementTitle: string;
  /** Prospective attribution — the delivering PARTY (agency, or the expert if independent). */
  readonly expertParty: string;
  readonly clientCompany: string;
  /** `accepted_at` (project) | `closed_at` (case), pre-formatted UTC. */
  readonly anchorDate: string;
  /** OPTIONAL — feeds step 2's regrounding. No producer today; the copy reads fine without it. */
  readonly consultationCount?: number;
  /**
   * CASE ONLY — why the case closed, threaded from `case_engagements.close_reason` by
   * the sweep. Drives step 2's closing clause (see {@link caseStepTwoLead}). ABSENT on
   * the project arm and on a case with no reason recorded — the copy falls back to the
   * neutral wording, never to the "went quiet" one.
   */
  readonly closeReason?: 'resolved' | 'auto_inactive';
  /** RAW review-invite token — appears ONLY inside the star hrefs. */
  readonly reviewToken: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

interface NudgeCopy {
  readonly preview: string;
  readonly pill: string;
  readonly heading: string;
  readonly subtext: string;
  readonly lead: ReactNode;
  readonly ask: string;
  readonly terminalLine: string;
}

function stepOneCopy(props: Readonly<ReviewNudgeEmailProps>, noun: string): NudgeCopy {
  const { engagementTitle, expertParty, anchorDate } = props;
  return {
    preview: `A star rating for ${engagementTitle} — it takes a couple of seconds.`,
    pill: '⭐ One quick thing',
    heading: 'How did it go?',
    subtext: `Your ${noun} wrapped up on ${anchorDate}.`,
    lead: (
      <>
        Your {noun} — <strong>{engagementTitle}</strong> — wrapped up on {anchorDate}.
      </>
    ),
    ask: `If you have a couple of seconds, a star rating is the most useful thing you can leave behind: it tells the next client what working with ${expertParty} is actually like.`,
    terminalLine: "We'll ask once more and then leave it there.",
  };
}

/**
 * Step 2's CASE regrounding paragraph.
 *
 * ⚠ THE CLOSING CLAUSE IS CLOSE-REASON-AWARE, AND MUST STAY THAT WAY. `close_reason` is
 * a real two-value enum: `auto_inactive` is Balo tidying up after a quiet case, while
 * `resolved` is the CLIENT'S OWN deliberate close. Asserting the first over the second
 * would tell a client they went quiet about an action they took themselves, seven days
 * after the close email correctly said "That's {case} wrapped up." This mirrors
 * `CaseClosedEmail`'s `wentQuiet` branch exactly — keep the two in step.
 *
 * An ABSENT reason (a case row with none recorded) takes the NEUTRAL arm, which is true
 * of both reasons — never the accusatory one.
 */
function caseStepTwoLead(props: Readonly<ReviewNudgeEmailProps>, consultations: string): ReactNode {
  const { engagementTitle, expertParty, anchorDate, closeReason } = props;
  const wentQuiet = closeReason === 'auto_inactive';
  return (
    <>
      This one goes back a bit, so here&apos;s the whole picture: you opened{' '}
      <strong>{engagementTitle}</strong> and worked through it with {expertParty}
      {consultations}
      {wentQuiet
        ? `. Things went quiet after that, so we closed the case out on ${anchorDate} rather than leave it hanging.`
        : `, and we closed the case out on ${anchorDate}.`}
    </>
  );
}

function stepTwoCopy(props: Readonly<ReviewNudgeEmailProps>, noun: string): NudgeCopy {
  const { engagementKind, engagementTitle, expertParty, clientCompany, anchorDate } = props;
  const consultations = consultationClause(props.consultationCount);
  const lead =
    engagementKind === 'case' ? (
      caseStepTwoLead(props, consultations)
    ) : (
      <>
        This one goes back a bit, so here&apos;s the whole picture: {expertParty} delivered{' '}
        <strong>{engagementTitle}</strong> for {clientCompany}
        {consultations}, and it was accepted on {anchorDate}.
      </>
    );
  return {
    preview: `The last time we'll ask about ${engagementTitle}.`,
    pill: '⭐ The last ask',
    heading: 'One last look back',
    subtext: `${noun === 'case' ? 'Closed out' : 'Accepted'} on ${anchorDate}.`,
    lead,
    ask: 'If any of it still stands out — good or otherwise — a star rating is the most useful thing you can leave behind.',
    terminalLine: "That's the last time we'll ask about this one — no more reminders either way.",
  };
}

export function ReviewNudgeEmail(props: Readonly<ReviewNudgeEmailProps>) {
  const {
    firstName = 'there',
    cadenceStep,
    engagementKind,
    expertParty,
    reviewToken,
    engagementUrl,
    baseUrl,
  } = props;
  const noun = engagementKind === 'case' ? 'case' : 'project';
  const copy = cadenceStep === 2 ? stepTwoCopy(props, noun) : stepOneCopy(props, noun);
  const promptLine =
    engagementKind === 'case'
      ? `How was your consultation with ${expertParty}?`
      : `How was working with ${expertParty}?`;

  return (
    <ReviewEmailLayout
      preview={copy.preview}
      pill={copy.pill}
      heading={copy.heading}
      subtext={copy.subtext}
    >
      <Text style={reviewStyles.greeting}>Hi {firstName},</Text>
      <Text style={reviewStyles.bodyText}>{copy.lead}</Text>
      <Text style={reviewStyles.bodyText}>{copy.ask}</Text>

      <ReviewAskBlock baseUrl={baseUrl} reviewToken={reviewToken} promptLine={promptLine} />

      <Text style={reviewStyles.ctaSubline}>{copy.terminalLine}</Text>

      <Hr style={reviewStyles.divider} />
      <Text style={{ ...reviewStyles.bodyText, fontSize: '13px', margin: 0 }}>
        Everything from this {noun} stays in your workspace —{' '}
        <Link href={engagementUrl} style={reviewStyles.footerLink}>
          open it any time
        </Link>
        .
      </Text>
    </ReviewEmailLayout>
  );
}
