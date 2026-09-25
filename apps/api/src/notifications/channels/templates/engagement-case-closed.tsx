import { Button, Hr, Section, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import {
  consultationClause,
  heroTitleOr,
  ReviewEmailLayout,
  reviewStyles,
  WhatHappensNowBlock,
} from './review-email-shared.js';
import { ReviewAskBlock } from './review-ask-block.js';

/**
 * BAL-390 (D4) — `CaseClosedEmail`, the FUSED case-close email: close confirmation →
 * case summary → the star-rating ask, in that order. ONE email, never two — the
 * record is the primary content and the ask is secondary.
 *
 * ⚠ LIVE AS OF BAL-388. The recap's `resolveCaseAction` publishes `closeReason: 'resolved'`;
 * BAL-572's hourly `case-inactivity-sweep` (`apps/api`) publishes `closeReason: 'auto_inactive'`
 * — both real emails to a real client.
 *
 * `reviewToken` ABSENT ⇒ the star block is omitted ENTIRELY — not greyed, gone. For a
 * `resolved` close, absent means already rated, and it is replaced by one short
 * thank-you line (the rating was captured at end-of-call and the client is never chased
 * for it); for an `auto_inactive` close with no token, NO rating content renders at all —
 * there was never a rating occasion to thank, and the +24h nudge (BAL-390) asks separately.
 *
 * TONE (BAL-329, binding): warm and properly-closed-off, never a reprimand. The
 * `auto_inactive` variant must read as Balo tidying up ("rather than leave it
 * hanging"), never as "you went quiet on us". Prospective copy names the PARTY
 * (`expertParty`). Dates are pre-formatted UTC strings.
 *
 * All copy is DRAFT pending MJ sign-off. Gender-neutral throughout.
 */
export interface CaseClosedEmailProps {
  readonly firstName: string;
  readonly clientCompany: string;
  /** Prospective attribution — the delivering PARTY (agency, or the expert if independent). */
  readonly expertParty: string;
  readonly caseTitle: string;
  readonly closedDate: string;
  readonly closeReason: 'resolved' | 'auto_inactive';
  /** OPTIONAL — every sentence reads naturally without it (a never-consulted case). */
  readonly consultationCount?: number;
  /** RAW review-invite token. ABSENT ⇒ no star block (see the docblock above). */
  readonly reviewToken?: string;
  /**
   * ⚠ THE RECAP, NOT THE ENGAGEMENT. `/engagements/[id]` 404s BY CONSTRUCTION for a case — that
   * route's loader filters `engagement_type = project`, so a case id resolves to `undefined`
   * and it `notFound()`s. This was the ONLY navigation in the first close email the platform
   * ever sends. ABSENT ⇒ NO button at all: a missing CTA is honest, a dead one is not.
   */
  readonly recapUrl?: string;
  readonly baseUrl: string;
}

export function CaseClosedEmail({
  firstName = 'there',
  clientCompany = 'your team',
  expertParty = 'your expert',
  caseTitle = 'your case',
  closedDate,
  closeReason,
  consultationCount,
  reviewToken,
  recapUrl,
  baseUrl,
}: Readonly<CaseClosedEmailProps>) {
  const wentQuiet = closeReason === 'auto_inactive';
  const consultations = consultationClause(consultationCount);
  const neverConsulted = consultations === '';
  const heroTitle = heroTitleOr(caseTitle, 'Your case');

  let lead: ReactNode;
  if (wentQuiet && neverConsulted) {
    lead = (
      <>
        <strong>{caseTitle}</strong> had been quiet for a while, so we closed it out on {closedDate}{' '}
        rather than leave it hanging. Everything from it stays exactly where it is.
      </>
    );
  } else if (wentQuiet) {
    lead = (
      <>
        <strong>{caseTitle}</strong> had been quiet for a while, so we closed it out on {closedDate}{' '}
        rather than leave it hanging. You worked through it with {expertParty}
        {consultations}, and everything from it stays exactly where it is.
      </>
    );
  } else {
    lead = (
      <>
        That&apos;s <strong>{caseTitle}</strong> wrapped up. You worked through it with{' '}
        {expertParty}
        {consultations}, and we closed the case out on {closedDate}.
      </>
    );
  }

  let reviewSection: ReactNode = null;
  if (reviewToken !== undefined) {
    reviewSection = (
      <ReviewAskBlock
        baseUrl={baseUrl}
        reviewToken={reviewToken}
        promptLine={`How was your consultation with ${expertParty}?`}
      />
    );
  } else if (closeReason === 'resolved') {
    reviewSection = (
      <Text style={reviewStyles.ctaSubline}>
        Thanks for rating this one already — that is genuinely useful to the next client.
      </Text>
    );
  }

  return (
    <ReviewEmailLayout
      preview={
        wentQuiet
          ? `${caseTitle} has been closed out — everything from it is still in your workspace.`
          : `${caseTitle} is wrapped up — everything from it is still in your workspace.`
      }
      pill={wentQuiet ? '✅ Case closed' : '✅ Case resolved'}
      heading={wentQuiet ? `${heroTitle} is closed` : `${heroTitle} is wrapped up`}
      subtext={
        wentQuiet
          ? `Closed out on ${closedDate} for ${clientCompany}.`
          : `Closed on ${closedDate} for ${clientCompany}.`
      }
    >
      <Text style={reviewStyles.greeting}>Hi {firstName},</Text>
      <Text style={reviewStyles.bodyText}>{lead}</Text>

      <WhatHappensNowBlock>
        Every consultation, note and action item from this case stays in your workspace, whenever
        you want them. Opening a new case with {expertParty} takes a moment.
      </WhatHappensNowBlock>

      {reviewSection}

      {recapUrl === undefined ? null : (
        <Section style={reviewStyles.ctaWrapper}>
          <Button style={reviewStyles.ctaPrimary} href={recapUrl}>
            View the recap →
          </Button>
        </Section>
      )}

      <Hr style={reviewStyles.divider} />
      <Text style={{ ...reviewStyles.bodyText, fontSize: '13px', margin: 0 }}>
        Still something unresolved here? Just reply to this email and the Balo team will help —
        closing the case doesn&apos;t close the conversation.
      </Text>
    </ReviewEmailLayout>
  );
}
