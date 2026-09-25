import { Button, Section, Text } from '@react-email/components';
import { CASE_INACTIVITY_DAYS } from '@balo/shared/engagements';
import {
  consultationClause,
  heroTitleOr,
  ReviewEmailLayout,
  reviewStyles,
  WhatHappensNowBlock,
} from './review-email-shared.js';

/**
 * BAL-572 — `CaseClosedExpertEmail`, the EXPERT half of the case-close notice. `auto_inactive`
 * ONLY: the notification rule (`rules.ts`) gates this template's delivery to the +30d inactivity
 * sweep, so a client's deliberate `resolved` close never reaches an expert here. The delivering
 * expert only — no agency owner/admin fan-out: unlike the ADR-1046 visibility surfaces
 * (`actorHasExpertSideVisibility`), this notice is a delivery record for the one person who did
 * the work, not a party-wide broadcast.
 *
 * ⚠ NO REVIEW BLOCK. Unlike `CaseClosedEmail` (the client half), this template carries no star
 * ask — the expert is not the one being asked to rate. It is the RECORD only, plus a link back
 * to the case.
 *
 * ⚠ THE CTA IS THE CASE, NOT THE RECAP. `/cases/{engagementId}` always resolves — unlike the
 * client half's recap link, this template has no reviewer-side meeting anchor to key off, and
 * the case surface is the expert's own delivery workspace for this engagement.
 *
 * TONE (BAL-329, binding): warm and properly-closed-off, never a reprimand — Balo tidying up
 * ("rather than leave it hanging"), never "you went quiet on this". Prospective copy names the
 * client PARTY (`clientCompany`), never a pronoun. Dates are pre-formatted UTC strings.
 *
 * Copy is DRAFT pending MJ sign-off. Gender-neutral throughout.
 */
export interface CaseClosedExpertEmailProps {
  readonly firstName: string;
  readonly clientCompany: string;
  readonly caseTitle: string;
  readonly closedDate: string;
  /** OPTIONAL — every sentence reads naturally without it (a never-consulted case). */
  readonly consultationCount?: number;
  readonly caseUrl: string;
}

export function CaseClosedExpertEmail({
  firstName = 'there',
  clientCompany = 'the client',
  caseTitle = 'the case',
  closedDate,
  consultationCount,
  caseUrl,
}: Readonly<CaseClosedExpertEmailProps>) {
  const consultations = consultationClause(consultationCount);
  const heroTitle = heroTitleOr(caseTitle, 'The case');
  const workedClause = consultations === '' ? null : <> You worked on it{consultations}.</>;

  return (
    <ReviewEmailLayout
      preview={`${caseTitle} has been closed out for inactivity.`}
      pill="✅ Case closed"
      heading={`${heroTitle} is closed`}
      subtext={`Closed out on ${closedDate}.`}
    >
      <Text style={reviewStyles.greeting}>Hi {firstName},</Text>
      <Text style={reviewStyles.bodyText}>
        <strong>{caseTitle}</strong> with {clientCompany} had been quiet for {CASE_INACTIVITY_DAYS}{' '}
        days with nothing booked, so we closed it out on {closedDate} rather than leave it hanging.
        {workedClause}
      </Text>

      <WhatHappensNowBlock>
        Everything from the case stays on the case page. If there&apos;s more to do, {clientCompany}{' '}
        can open a new case any time.
      </WhatHappensNowBlock>

      <Section style={reviewStyles.ctaWrapper}>
        <Button style={reviewStyles.ctaPrimary} href={caseUrl}>
          View case →
        </Button>
      </Section>
    </ReviewEmailLayout>
  );
}
