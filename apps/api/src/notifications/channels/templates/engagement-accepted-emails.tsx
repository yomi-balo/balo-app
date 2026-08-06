import { Button, Hr, Section, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import {
  heroTitleOr,
  milestonePhrases,
  ReviewEmailLayout,
  reviewStyles,
  WhatHappensNowBlock,
} from './review-email-shared.js';
import { ReviewAskBlock } from './review-ask-block.js';

/**
 * BAL-338 (D7) + BAL-390 — the CLIENT-facing "your project is complete" email, in ONE
 * body serving BOTH acceptance paths, discriminated on `method`:
 *
 *   · `method: 'auto'`   → template `engagement-auto-accepted-client` (VARIANT 3 of the
 *                          project-review family, `AutoAcceptedEmail` in
 *                          `engagement-auto-accepted.tsx` — that file is now a thin
 *                          wrapper over this body). The D7 sweep closed the project out
 *                          when the review window elapsed. NOBODY ACTED.
 *   · `method: 'client'` → template `engagement-accepted-client` (`AcceptedClientEmail`,
 *                          below). The client explicitly clicked accept.
 *
 * ⚠ ONE BODY IS DELIBERATE, NOT AN OPTIMISATION. The two variants differ by roughly one
 * sentence, so writing them as two near-identical templates trips SonarCloud's >3%
 * new-code duplication gate — a hard PR gate on this repo. House patterns: the
 * `credit-dormancy-reminder` template switches on `payload.window`; `review-email-shared`
 * already holds this family's shared shell. If you need a third acceptance variant, add
 * a `method`, not a file.
 *
 * ── WHY THE CLIENT NOW GETS AN EMAIL ON THE EXPLICIT-ACCEPT PATH (BAL-390) ───────────
 * `payment.charged` emails the ACTING member their own personal receipt; so do
 * `credit.topup.completed` and `promo.redeemed`. Actor-gets-a-receipt is the house
 * pattern at money moments, and acceptance is the trigger for the final invoice — so the
 * client should hold written evidence of it without having to log in. BAL-338's former
 * "No client recipient (they just acted)" ruling is the OUTLIER and this ticket
 * deliberately overturns it. Recipient is `'self'` via `payload.userId` (the
 * `payment.charged` shape); the auto path legitimately differs (recipient `'client'` via
 * `recipientId`, because nobody acted) — that asymmetry is correct, do not harmonise it.
 *
 * ── STRUCTURE: RECORD FIRST, REVIEW ASK SECOND ──────────────────────────────────────
 * Confirmation paragraph → the green "what happens now" record block → THEN the star
 * ask when `reviewToken` is present. The acceptance record is the primary content; the
 * rating ask is secondary. Same contract as the fused case-close email.
 *
 * `reviewToken` ABSENT ⇒ the star block is omitted entirely (not greyed — gone). What
 * goes in its place is decided by `alreadyRated`, NOT by the missing token:
 *   · CLIENT path + `alreadyRated` ⇒ one short thank-you line.
 *   · CLIENT path, token mint FAILED ⇒ nothing. `accept-project.ts` publishes without a
 *     token when the mint throws (a rating-token failure must never break an accept), and
 *     thanking someone for a review they never left is worse than saying nothing. This is
 *     why the two states are carried as a separate boolean and not inferred from the
 *     token's absence — the publisher is the only layer that knows which happened.
 *   · AUTO path ⇒ nothing, always: nobody acted, so there is nothing to thank, and that
 *     email renders exactly as it did before BAL-390.
 *
 * TONE (BAL-329, binding): congratulatory — the project is complete. Prospective copy
 * names the PARTY (`expertParty`). Dates are pre-formatted UTC strings;
 * `milestonesTotal` must read naturally at 0/1/N (the retainer seam).
 *
 * All BAL-390 copy is DRAFT pending MJ sign-off. Gender-neutral throughout.
 */

/** Capitalise the first character of a non-empty clause (e.g. "all 4 …" → "All 4 …"). */
export function capitalizeClause(clause: string): string {
  return clause === '' ? '' : `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
}

interface ProjectAcceptedBaseProps {
  readonly firstName: string;
  readonly clientCompany: string;
  /** Prospective attribution — the delivering PARTY (agency, or the expert if independent). */
  readonly expertParty: string;
  readonly projectTitle: string;
  readonly milestonesTotal: number;
  readonly engagementUrl: string;
  /** App origin — only used to build the review landing URL. */
  readonly baseUrl: string;
  /** BAL-390 RAW review-invite token. Absent ⇒ no star block (see the docblock). */
  readonly reviewToken?: string;
}

/** VARIANT 3 — the D7 sweep closed the project out after the review window elapsed. */
export interface AutoAcceptedEmailProps extends ProjectAcceptedBaseProps {
  readonly requestedDate: string;
  readonly autoDate: string;
  readonly reviewDays: number;
}

/** BAL-390 — the client explicitly accepted; this is THEIR record of having done so. */
export interface AcceptedClientEmailProps extends ProjectAcceptedBaseProps {
  readonly acceptedOn: string;
  /**
   * This member has ALREADY rated this expert on this engagement. The ONLY thing that
   * licenses the thank-you line. ⚠ Do not re-derive it from `reviewToken === undefined`:
   * the token is equally absent when the mint failed, and thanking someone for a review
   * they never left is a lie the reader can spot. Absent/false ⇒ nothing is rendered in
   * the star block's place.
   */
  readonly alreadyRated?: boolean;
}

export type ProjectAcceptedEmailProps =
  | ({ readonly method: 'auto' } & AutoAcceptedEmailProps)
  | ({ readonly method: 'client' } & AcceptedClientEmailProps);

interface AcceptedCopy {
  readonly preview: string;
  readonly subtext: string;
  readonly lead: ReactNode;
}

function autoCopy(props: Readonly<AutoAcceptedEmailProps>, deliveredAlong: string): AcceptedCopy {
  const { projectTitle, clientCompany, expertParty, autoDate, requestedDate, reviewDays } = props;
  return {
    preview: `${projectTitle} is complete — wrapped up as delivered on ${autoDate} after the review window.`,
    subtext: `Wrapped up as delivered after ${clientCompany}'s ${reviewDays}-day review window.`,
    lead: (
      <>
        Congratulations — <strong>{projectTitle}</strong> is complete! {clientCompany}&apos;s review
        window wrapped up on {autoDate}, so we closed the project out as delivered, just as flagged
        when {expertParty} sent it over on {requestedDate}.
        {deliveredAlong === '' ? '' : ` ${deliveredAlong}.`}
      </>
    ),
  };
}

function clientCopy(
  props: Readonly<AcceptedClientEmailProps>,
  deliveredAlong: string
): AcceptedCopy {
  const { projectTitle, clientCompany, expertParty, acceptedOn } = props;
  return {
    preview: `${projectTitle} is complete — your record of accepting it on ${acceptedOn}.`,
    subtext: `Accepted for ${clientCompany} on ${acceptedOn}.`,
    lead: (
      <>
        Congratulations — <strong>{projectTitle}</strong> is complete! You accepted the work{' '}
        {expertParty} delivered, on {acceptedOn}. This email is your record of that, and Balo takes
        care of the final invoice from here.
        {deliveredAlong === '' ? '' : ` ${deliveredAlong}.`}
      </>
    ),
  };
}

/** The ONE shared body. `method` selects the preview, subtext and lead paragraph. */
export function ProjectAcceptedEmail(props: Readonly<ProjectAcceptedEmailProps>) {
  const {
    firstName = 'there',
    projectTitle = 'your project',
    milestonesTotal = 0,
    reviewToken,
    engagementUrl,
    baseUrl,
    expertParty,
  } = props;
  const deliveredAlong = capitalizeClause(milestonePhrases(milestonesTotal).deliveredAlongClause);
  const copy =
    props.method === 'auto' ? autoCopy(props, deliveredAlong) : clientCopy(props, deliveredAlong);

  return (
    <ReviewEmailLayout
      preview={copy.preview}
      pill="🎉 Project complete"
      heading={`${heroTitleOr(projectTitle, 'Your project')} is complete`}
      subtext={copy.subtext}
    >
      <Text style={reviewStyles.greeting}>Hi {firstName},</Text>
      <Text style={reviewStyles.bodyText}>{copy.lead}</Text>

      <WhatHappensNowBlock>
        Balo will be in touch about the final invoice. The delivery plan and every delivery note
        stay right where they are in your workspace, whenever you want them.
      </WhatHappensNowBlock>

      {reviewToken === undefined ? (
        // AUTO never carries the flag, so this is `false` there by construction.
        <ThankYouWhenRated
          alreadyRated={props.method === 'client' && props.alreadyRated === true}
        />
      ) : (
        <ReviewAskBlock
          baseUrl={baseUrl}
          reviewToken={reviewToken}
          promptLine={`How was working with ${expertParty}?`}
        />
      )}

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

/**
 * The already-rated stand-in — rendered ONLY on an explicit `alreadyRated`, never on the
 * mere absence of a token. False on the AUTO path by construction (nobody acted, so there
 * is nothing to thank) and false when the CLIENT path's token mint failed, in both cases
 * leaving the star block's slot empty rather than asserting something untrue.
 */
function ThankYouWhenRated({ alreadyRated }: Readonly<{ alreadyRated: boolean }>) {
  if (!alreadyRated) return null;
  return (
    <Text style={reviewStyles.ctaSubline}>
      Thanks for rating this one already — that is genuinely useful to the next client.
    </Text>
  );
}

/**
 * BAL-390 — `engagement-accepted-client`. Thin wrapper; the body lives above so the two
 * acceptance emails cannot drift and cannot duplicate.
 */
export function AcceptedClientEmail(props: Readonly<AcceptedClientEmailProps>) {
  return <ProjectAcceptedEmail method="client" {...props} />;
}
