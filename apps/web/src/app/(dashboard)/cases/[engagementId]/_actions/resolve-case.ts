'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import {
  CaseAlreadyClosedError,
  CaseCloserNotMemberError,
  caseEngagementsRepository,
} from '@balo/db';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { trackServerAndFlush, RECAP_SERVER_EVENTS } from '@/lib/analytics/server';
import {
  capCaseTitle,
  publishCaseClosed,
  readCloseAnchors,
  resolveReviewAsk,
} from '@/lib/cases/close-case-effects';
import { authorizeCaseMutation } from '../_lib/authorize-case-mutation';
import type { CaseActionResult } from './_types/case-action-types';

/**
 * BAL-421 — THE CLIENT MARKS A CASE RESOLVED, FROM THE CASE SURFACE. The SECOND entry point
 * onto BAL-388's shipped close contract.
 *
 * ⚠⚠ A SECOND ENTRY POINT, NOT A SECOND IMPLEMENTATION. The whole post-commit half lives in
 * `@/lib/cases/close-case-effects` and is SHARED with the recap's `resolve-case.ts`, never
 * copied. That extraction is load-bearing for two reasons beyond duplication: the review-token
 * mint must agree with the VERIFIER on its hashing algorithm forever (a drifted copy would
 * keep every test green while rendering a dead link for every emailed star row), and the
 * hardened catch that logs `errorName`/`errorCode` instead of `message` is the most
 * copy-fragile code in the file — drizzle interpolates the SHA-256 token hash into
 * `DrizzleQueryError.message`.
 *
 * ── ⚠ THE AUTHORIZATION ORDER, AND WHY THE LENS ASSERTION COMES FIRST ─────────────────────
 *   1. `authorizeCaseMutation` — onboarded session, strict Zod, the FULL tenancy gate re-run
 *      (Server Actions bypass middleware and must never trust the page's earlier decision),
 *      and the case-type coherence check AFTER it (BAL-129).
 *   2. `lens === 'client'` — AN EXPERT CAN NEVER CLOSE A CASE (BAL-417); they may only ASK.
 *      The expert's agency membership would never grant `PARTICIPATE` in the CLIENT's company
 *      anyway, so this is belt-and-braces — but it makes the rule LEGIBLE and gives it a test
 *      of its own, rather than leaving it as an emergent property of two other checks.
 *   3. `hasCapability(PARTICIPATE, { companyId })` — the MEMBERSHIP axis, with `companyId`
 *      RE-DERIVED FROM THE LOADED ENGAGEMENT ROW via the gate, never from the session and
 *      never from input (ADR-1029).
 *
 * `close()` then re-asserts its own DATA-INTEGRITY invariant (live membership of
 * `engagements.company_id`) and deliberately discards the role string, because "the call site
 * is BAL-421's server action". The two are complementary, not redundant: one is authorization,
 * one is row coherence.
 *
 * ⚠⚠ EXACTLY ONCE, AND IDEMPOTENT UNDER DOUBLE-SUBMIT. `close()` locks parent then child and
 * throws `CaseAlreadyClosedError` on a second call. That is treated as SUCCESS — the case IS
 * resolved, which is what the user asked for — but the post-commit half DOES NOT RUN AGAIN: no
 * second token is minted and, decisively, `publishNotificationEvent` DOES NOT FIRE A SECOND
 * TIME. A double-click must not send two close emails.
 */
export async function resolveCaseAction(input: {
  engagementId: string;
}): Promise<CaseActionResult> {
  const gate = await authorizeCaseMutation(input);
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  const { user, engagementId, companyId, expertProfileId, lens, caseRow } = gate;

  const denied = "You don't have permission to resolve this case.";
  if (lens !== 'client') {
    // BAL-417 — the expert may ASK, never close. See the docblock.
    return { success: false, error: denied };
  }

  try {
    const allowed = await hasCapability(user, CAPABILITIES.PARTICIPATE, { companyId });
    if (!allowed) {
      return { success: false, error: denied };
    }

    let closedAt: Date;
    try {
      const closed = await caseEngagementsRepository.close({
        engagementId,
        reason: 'resolved',
        userId: user.id,
      });
      closedAt = closed.closedAt ?? new Date();
    } catch (error) {
      if (error instanceof CaseAlreadyClosedError) {
        // ⚠ IDEMPOTENT SUCCESS, post-commit half DELIBERATELY SKIPPED. The first submit
        // already minted the token and published the close; running either again would send a
        // duplicate email and mint a second live token.
        revalidatePath('/cases/' + engagementId);
        return { success: true };
      }
      if (error instanceof CaseCloserNotMemberError) {
        return { success: false, error: denied };
      }
      throw error;
    }

    // ── POST-COMMIT. NOTHING BELOW MAY FAIL THE CLOSE. ──
    // ⚠ ONE SIBLING READ FOR BOTH FIGURES. The held count and the CTA anchor come from the
    // SAME `listMeetingsForContext` result, so a close issues that query exactly once.
    //
    // ⚠ THE ANCHOR IS THE MOST RECENT **HELD** CONSULTATION, AND `undefined` IS A FULLY
    // SUPPORTED ANSWER. `EngagementCaseClosedPayload.meetingId` is ALREADY OPTIONAL —
    // verified, not assumed — and its docblock states that when absent "the templates render
    // NO link at all rather than a dead one". So a case closed before any consultation was
    // held correctly emails no deep link. A cancelled or no-show meeting would resolve to a
    // recap saying the call never happened, which is a WORSE CTA than none. NEVER fabricate an
    // id, and never pick "the most recent meeting".
    const { heldCount, anchorMeetingId } = await readCloseAnchors(engagementId);

    const reviewToken = await resolveReviewAsk(
      engagementId,
      expertProfileId,
      // The RESOLVING member IS the reviewer — the same subject `reviewsRepository.findLive`
      // is asked about, and the same person `recipientId` names.
      user.id
    );
    await publishCaseClosed({
      engagementId,
      meetingId: anchorMeetingId,
      companyId,
      expertProfileId,
      caseTitle: capCaseTitle(caseRow.title),
      closedAt,
      recipientId: user.id,
      consultationCount: heldCount,
      reviewToken,
    });

    // ⚠ `source: 'case_surface'` — THE SECOND VALUE OF THE DIMENSION THAT EXISTS TO MEASURE
    // exactly this. No separate `case_resolved_manually` event: forking the name would split
    // the distribution across two events at the moment there were finally two to compare.
    trackServerAndFlush(RECAP_SERVER_EVENTS.CASE_RESOLVED, {
      source: 'case_surface',
      engagement_id: engagementId,
      distinct_id: user.id,
    });
    log.info('Case resolved', { engagementId, userId: user.id, source: 'case_surface' });

    revalidatePath('/cases/' + engagementId);
    return { success: true };
  } catch (error) {
    log.error('Failed to resolve case', {
      engagementId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
