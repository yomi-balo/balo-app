'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import {
  CaseAlreadyClosedError,
  CaseCloserNotMemberError,
  caseEngagementsRepository,
} from '@balo/db';
import { log } from '@/lib/logging';
import { trackServerAndFlush, RECAP_SERVER_EVENTS } from '@/lib/analytics/server';
import {
  capCaseTitle,
  publishCaseClosed,
  readHeldConsultationCount,
  resolveReviewAsk,
} from '@/lib/cases/close-case-effects';
import { authorizeRecapCaseMutation } from '../_lib/authorize-recap-case-mutation';
import type { RecapActionResult } from './_types/recap-action-types';

/**
 * BAL-388 §R9 — THE CLIENT MARKS A CASE RESOLVED. The platform FIRST production caller of
 * `caseEngagementsRepository.close()`.
 *
 * ⚠⚠ THE FOUR AUTHORIZATION GATES LIVE IN `authorizeRecapCaseMutation`, SHARED WITH
 * `dismiss-resolution-request.ts` — signed-in wrapper, strict Zod (meetingId is the ONLY
 * trusted input; there is no `engagementId` field, so a caller cannot name a case they could
 * not otherwise reach), the recap read gate re-run in full and asserted to be the CLIENT lens
 * on a `case` context (an expert can NEVER close a case — BAL-417), and
 * `hasCapability(PARTICIPATE, companyId)` on the MEMBERSHIP axis with the companyId from THE
 * GATE (ADR-1029). That module also NARROWS `expertProfileId` to non-null, which is why the
 * post-commit half below carries no defensive branch: `engagements.expert_profile_id` is NOT
 * NULL, so a case can never reach here nameless, and a dead `!== null` guard around the review
 * token AND the publish would be untested, uncovered, and silently email-less if it ever fired.
 *
 * ⚠⚠ THE TWO-STEP CLOSE CONTRACT (D-F). `close()` writes the row; the CALLER then owes,
 * POST-COMMIT and never throwing:
 *   1. mint a `review_invite_tokens` row for the resolved client-side reviewer, and
 *   2. publish `engagement.case_closed` carrying the RAW token.
 * Both are best-effort. Neither may fail the close.
 *
 * ⚠⚠ EXACTLY ONCE, AND IDEMPOTENT UNDER DOUBLE-SUBMIT. `close()` locks parent then child and
 * throws `CaseAlreadyClosedError` on a second call. That is treated as SUCCESS — the case IS
 * resolved, which is what the user asked for — but the post-commit half DOES NOT RUN AGAIN:
 * no second token is minted and, decisively, `publishNotificationEvent` DOES NOT FIRE A SECOND
 * TIME. A double-click must not send two close emails.
 */
export async function resolveCaseAction(input: { meetingId: string }): Promise<RecapActionResult> {
  const gate = await authorizeRecapCaseMutation(
    input,
    "You don't have permission to resolve this case."
  );
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  const { user, meetingId, engagementId, companyId, expertProfileId } = gate;

  try {
    const caseRow = await caseEngagementsRepository.findByEngagementId(engagementId);
    if (caseRow === undefined) {
      return { success: false, error: 'This recap is no longer available.' };
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
        // ⚠ IDEMPOTENT SUCCESS, and the post-commit half is DELIBERATELY SKIPPED. The first
        // submit already minted the token and published the close; running either again would
        // send a duplicate email and mint a second live token.
        revalidatePath('/meetings/' + meetingId);
        return { success: true };
      }
      if (error instanceof CaseCloserNotMemberError) {
        return { success: false, error: "You don't have permission to resolve this case." };
      }
      throw error;
    }

    // POST-COMMIT. Nothing below may fail the close, and all of it lives in
    // `@/lib/cases/close-case-effects` — SHARED with the case surface's second entry point,
    // never copied. See that module's docblock for why (one definition of the token-mint
    // algorithm; one copy of the hardened catch).
    const heldCount = await readHeldConsultationCount(engagementId);

    const reviewToken = await resolveReviewAsk(
      engagementId,
      expertProfileId,
      // The RESOLVING member IS the reviewer — the same subject `reviewsRepository.findLive`
      // is asked about, and the same person `recipientId` names.
      user.id
    );
    await publishCaseClosed({
      engagementId,
      meetingId,
      companyId,
      expertProfileId,
      caseTitle: capCaseTitle(caseRow.title),
      closedAt,
      recipientId: user.id,
      consultationCount: heldCount,
      reviewToken,
    });

    trackServerAndFlush(RECAP_SERVER_EVENTS.CASE_RESOLVED, {
      source: 'recap',
      engagement_id: engagementId,
      distinct_id: user.id,
    });
    log.info('Case resolved', { engagementId, meetingId, userId: user.id, source: 'recap' });

    revalidatePath('/meetings/' + meetingId);
    return { success: true };
  } catch (error) {
    log.error('Failed to resolve case', {
      meetingId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
