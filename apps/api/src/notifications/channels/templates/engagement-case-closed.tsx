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
 * ⚠ LIVE AS OF BAL-388. The recap's `resolveCaseAction` is the FIRST and (today) only
 * publisher of `engagement.case_closed`, so this is a real email that a real client
 * receives. The `auto_inactive` arm is still unpublished (BAL-420's sweep owns it), which
 * is why the quiet-close copy stays. Do not describe this template as inert.
 *
 * `reviewToken` ABSENT ⇒ already rated ⇒ the star block is omitted ENTIRELY — not
 * greyed, gone — and replaced by one short thank-you line. That is the BEST outcome:
 * the rating was captured at end-of-call and the client is never chased for it.
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
  /** OPTIONAL — no producer today; every sentence reads naturally without it. */
  readonly consultationCount?: number;
  /** RAW review-invite token. ABSENT ⇒ already rated ⇒ no star block at all. */
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
  const heroTitle = heroTitleOr(caseTitle, 'Your case');

  const lead: ReactNode = wentQuiet ? (
    <>
      <strong>{caseTitle}</strong> had been quiet for a while, so we closed it out on {closedDate}{' '}
      rather than leave it hanging. You worked through it with {expertParty}
      {consultations}, and everything from it stays exactly where it is.
    </>
  ) : (
    <>
      That&apos;s <strong>{caseTitle}</strong> wrapped up. You worked through it with {expertParty}
      {consultations}, and we closed the case out on {closedDate}.
    </>
  );

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

      {reviewToken === undefined ? (
        <Text style={reviewStyles.ctaSubline}>
          Thanks for rating this one already — that is genuinely useful to the next client.
        </Text>
      ) : (
        <ReviewAskBlock
          baseUrl={baseUrl}
          reviewToken={reviewToken}
          promptLine={`How was your consultation with ${expertParty}?`}
        />
      )}

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
