'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  CaseAlreadyClosedError,
  CaseCloserNotMemberError,
  caseEngagementsRepository,
} from '@balo/db';
import { log } from '@/lib/logging';
import { meetingAllowsPostCallActions } from '@/lib/meetings/post-call-eligibility';
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
 * WHICH SURFACE INITIATED THE CLOSE — an ANALYTICS DIMENSION ONLY. It gates nothing, grants
 * nothing and is never compared against the caller's identity.
 *
 * ⚠ IT IS STILL PARSED, BECAUSE IT IS CALLER-SUPPLIED. A Server Action argument is
 * attacker-controllable, and an unvalidated string reaching PostHog would let anyone mint
 * arbitrary `case_resolved.source` values and poison the one measurement this property exists
 * for. `.default('recap')` keeps every existing recap call site byte-identical.
 *
 * ⚠⚠ IT IS DELIBERATELY NARROWER THAN `CaseResolveSource`, WHICH NOW HAS THREE MEMBERS. THIS
 * action serves exactly TWO surfaces — the recap and the end-of-call screen — and BAL-421's
 * case surface has its OWN action at `cases/[engagementId]/_actions/resolve-case.ts` that
 * threads `case_surface` itself. Widening this enum to the full union would let a recap caller
 * claim a close came from a surface it cannot have come from, which is exactly the poisoning
 * the parse exists to prevent. `resolve-case.test.ts` pins this SUBSET relationship.
 */
const caseResolveSourceSchema = z.enum(['recap', 'end_of_call']).default('recap');

/**
 * The refusal when the consultation has not taken place. ONE literal for BOTH halves of the rule
 * — a future `scheduled_start` and a `cancelled` status — because the honest sentence is the same
 * either way, and splitting it would tell a caller which half they tripped for no benefit.
 *
 * ⚠ IT IS NOT AN EXISTENCE ORACLE, and it does not need to be coy. The caller has already
 * cleared the full recap read gate by this point, so they demonstrably may READ this meeting;
 * naming why the CLOSE is refused discloses nothing they cannot see on the page itself.
 */
const NOT_YET_HELD = 'This case can only be resolved from a consultation that has taken place.';

/**
 * BAL-388 §R9 — THE CLIENT MARKS A CASE RESOLVED. The platform FIRST production caller of
 * `caseEngagementsRepository.close()`.
 *
 * ⚠⚠ TWO MEETING SURFACES, ONE CLOSE PATH (BAL-389). The recap and the end-of-call screen both
 * reach THIS action; the only thing that varies is the `source` analytics dimension. It was NOT
 * forked, deliberately: a second close path would fork the `findLive`-then-mint contract PR
 * #191's review hardened, and would give one business fact two event names — making
 * `count(case_resolved)` wrong and forcing every funnel to union them forever.
 *
 * ⚠⚠ BAL-421's CASE SURFACE IS A THIRD ENTRY POINT WITH ITS OWN ACTION
 * (`cases/[engagementId]/_actions/resolve-case.ts`), AND THAT IS NOT A CONTRADICTION OF THE
 * ABOVE. It is anchored on an `engagementId` with NO meeting in scope, so it cannot clear this
 * action's meeting-shaped gate at all. What must never fork — the post-commit half — does not:
 * both actions call the SAME `@/lib/cases/close-case-effects` and emit the SAME `case_resolved`
 * event, differing only in `source`. The 30-day inactivity sweep widens `CaseResolveSource` the
 * same way when it starts emitting.
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
 * ⚠⚠ THE **FIFTH** GATE LIVES IN THIS FILE, NOT IN THAT MODULE: the consultation must actually
 * have taken place (`meetingAllowsPostCallActions`). It is here rather than in the shared gate
 * because the shared gate also fronts `dismiss-resolution-request.ts`, whose outcome is
 * indistinguishable from doing nothing and which this finding does not concern. See the guard
 * itself, below, for why the render gate alone would not have been enough.
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
export async function resolveCaseAction(input: {
  meetingId: string;
  /** Analytics only. Defaults to `recap`, so BAL-388's two call sites are unchanged. */
  source?: 'recap' | 'end_of_call';
}): Promise<RecapActionResult> {
  // ⚠⚠ THE GATE CALL **MUST** DESTRUCTURE, AND THIS IS NOT STYLE.
  // `authorizeRecapCaseMutation`'s schema is `z.object({ meetingId: z.uuid() }).strict()` and it
  // is SHARED with `dismiss-resolution-request.ts`. Passing the widened `input` straight through
  // would fail the strict parse on the extra `source` key and DENY EVERY CLOSE — from both
  // surfaces, silently, as a permission error. Widening the gate's schema instead would let a
  // caller name fields the gate does not trust. `resolve-case.test.ts` pins this by regression.
  const gate = await authorizeRecapCaseMutation(
    { meetingId: input.meetingId },
    "You don't have permission to resolve this case."
  );
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  const { user, meetingId, engagementId, companyId, expertProfileId } = gate;

  /**
   * ⚠⚠ THE FIFTH GATE, AND THE LOAD-BEARING HALF OF THE FIX. The end-of-call loader also
   * declines to OFFER this on a meeting that has not happened — but a render-only check is
   * bypassable by invoking this Server Action directly, and what is on the other side of it is
   * IRREVERSIBLE. So the rule is enforced HERE, on the SAME predicate and the SAME two meeting
   * facts, which is what makes it ONE guard across BOTH surfaces: the recap's `ResolveDialog`
   * and the end-of-call `ResolvePrompt` both land on this action, and neither can be trusted to
   * have gated itself.
   *
   * ⚠ THIS DELIBERATELY TIGHTENS EXISTING RECAP BEHAVIOUR. `loadRecap` admits `ended` **and**
   * `cancelled`, so closing a case from a CANCELLED consultation's recap used to work and now
   * does not. That is the intended outcome, not collateral: a consultation that never went ahead
   * is not evidence that the client's issue is resolved.
   *
   * ⚠ BEFORE ANY WRITE, AND BEFORE THE `source` PARSE, so a refusal costs one gate and nothing
   * else. See `@/lib/meetings/post-call-eligibility` for why `started_at` cannot be the signal
   * and for the ACCEPTED no-show residual (BAL-134 tightens it).
   */
  if (!meetingAllowsPostCallActions(gate.meeting)) {
    log.warn('Case close refused — the consultation has not taken place', {
      meetingId,
      engagementId,
      userId: user.id,
      meetingStatus: gate.meeting.status,
    });
    return { success: false, error: NOT_YET_HELD };
  }

  const source = caseResolveSourceSchema.catch('recap').parse(input.source);

  /**
   * ⚠ BOTH MEETING SURFACES ARE REVALIDATED, UNCONDITIONALLY AND WITHOUT A `source` BRANCH.
   * The recap and the end-of-call screen render the same closed-case fact from the same row, and
   * a revalidate of a path the user is not on is a no-op — whereas a `source` conditional here
   * would be a SECOND place the surface is decided, free to disagree with the first.
   */
  const revalidateBothSurfaces = (): void => {
    revalidatePath('/meetings/' + meetingId);
    revalidatePath('/meetings/' + meetingId + '/end');
  };

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
        revalidateBothSurfaces();
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
      source,
      engagement_id: engagementId,
      distinct_id: user.id,
    });
    log.info('Case resolved', { engagementId, meetingId, userId: user.id, source });

    revalidateBothSurfaces();
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
