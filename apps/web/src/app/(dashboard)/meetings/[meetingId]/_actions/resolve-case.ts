'use server';

import 'server-only';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  CaseAlreadyClosedError,
  CaseCloserNotMemberError,
  caseEngagementsRepository,
  companiesRepository,
  expertsRepository,
  agenciesRepository,
  meetingContextsRepository,
  reviewInviteTokensRepository,
  reviewsRepository,
  usersRepository,
} from '@balo/db';
import { expertPartyDisplayName } from '@balo/shared/parties';
import { formatLongUtc } from '@/lib/format/utc-date';
import { log } from '@/lib/logging';
import { sha256Hex } from '@/lib/magic-link';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { trackServerAndFlush, RECAP_SERVER_EVENTS } from '@/lib/analytics/server';
import { authorizeRecapCaseMutation } from '../_lib/authorize-recap-case-mutation';
import { deriveConsultationOrdinal } from '../_lib/derive-consultation-ordinal';
import type { RecapActionResult } from './_types/recap-action-types';

/**
 * `case_title` is an UNCAPPED `text` column, but the publish schema caps it at 200 and
 * `publishNotificationEvent` SWALLOWS a 400 — so a long title would silently mean no close
 * email at all. Truncating here is the difference between a slightly shortened subject line
 * and a missing email.
 */
const CASE_TITLE_MAX = 200;

function capCaseTitle(title: string): string {
  if (title.length <= CASE_TITLE_MAX) return title;
  return title.slice(0, CASE_TITLE_MAX - 1) + '…';
}

/**
 * A driver/Postgres error `code` (`23505`, `ECONNREFUSED`, …) when the thrown value carries one.
 * Enough to route a failure without quoting the statement — see `resolveReviewAsk`'s catch.
 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * BAL-390 (D-F) — what the close email should carry about rating: the RAW magic-link token
 * for the resolving member, or NOTHING at all.
 *
 * ⚠ NEVER THROWS, AND MUST NOT. The close has ALREADY COMMITTED by the time this runs. A
 * rating token is a nice-to-have riding along with a terminal state change, so every failure
 * degrades to a TOKENLESS publish and the close still succeeds.
 *
 * ⚠⚠ HASHING GOES THROUGH `sha256Hex` FROM `@/lib/magic-link` — the SAME helper the
 * VERIFIER uses — never a re-inlined `createHash`, and never the api-side
 * `mintReviewInviteToken` (a web Server Action must not reach for it). Mint and verify must
 * agree on the algorithm FOREVER: switching this line to sha512/base64 would keep every other
 * test green while silently rendering a dead link for every emailed star row in production.
 * The algorithm is pinned by a test, mirrored from `accept-project.test.ts`.
 *
 * ⚠⚠ THE RAW TOKEN IS RETURNED ONCE AND IS NEVER PERSISTED OR LOGGED, AND NEITHER IS THE
 * HASH — WHICH IS WHY THE CATCH BELOW LOGS `name` / `code` AND NOT `message` OR `stack`. The
 * failing statement's bound params INCLUDE the SHA-256 token hash, and drizzle-orm interpolates
 * bound params into `DrizzleQueryError.message` (from ~0.41) — which `stack` then repeats
 * verbatim. A routine dependency bump would otherwise start writing a live token hash into
 * Axiom with no code change here at all. The guard is deliberately scoped to THIS catch: every
 * other error path in this file logs the full message and stack, because none of them can carry
 * a token as a bound param.
 */
async function resolveReviewAsk(
  engagementId: string,
  expertProfileId: string,
  reviewerUserId: string
): Promise<string | undefined> {
  try {
    const existing = await reviewsRepository.findLive(
      engagementId,
      reviewerUserId,
      expertProfileId
    );
    if (existing !== undefined) {
      // Already rated ⇒ NO token ⇒ the template omits the review block ENTIRELY.
      return undefined;
    }
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(rawToken);
    await reviewInviteTokensRepository.create({ engagementId, reviewerUserId, tokenHash });
    return rawToken;
  } catch (error) {
    // Never the token itself, never the hash, and never anything that could quote them.
    log.error('Review invite token mint failed', {
      engagementId,
      userId: reviewerUserId,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: errorCodeOf(error),
    });
    return undefined;
  }
}

/**
 * Publish `engagement.case_closed` — THE ONE PUBLISH. The event, its rule, its email and
 * in-app templates and its Zod publish arm ALL shipped in BAL-390 with NO publisher; this is
 * that publisher. Fire-and-forget by contract.
 *
 * ⚠ THE PAYLOAD SHAPE IS DECLARED ONCE, IN `@balo/shared/notifications`. Do NOT re-inline it
 * into the api or web lockstep catalogs — that is the SonarCloud duplication gate exact
 * shape (memory `reference_notification_event_dup_shared_home`).
 *
 * ⚠⚠ `meetingId` IS THE CTA SUBJECT ON BOTH CHANNELS, AND IT IS NOT OPTIONAL HERE. The
 * engagements route 404s BY CONSTRUCTION for a case (its loader filters engagement_type =
 * project), and this action is the event FIRST publisher — so shipping it without a live
 * destination would make the very first close email the platform ever sends end in a 404. Both
 * templates deep-link the RECAP with `?from=notification` instead.
 *
 * ⚠ THE READS ARE COLUMN-PROJECTED (`findNameById` / `findDisplayProfileById` /
 * `findDisplayById`) for the same reason the loader uses them: nothing here needs `rate_cents`,
 * `email` or `workosId`, and a payload is a place a stray column travels far.
 *
 * ⚠ `closeReason: resolved` IS THE HONEST REASON. Passing `auto_inactive` would make
 * BAL-390 +7d nudge assert that things went quiet about an action the client just took.
 */
async function publishCaseClosed(input: {
  engagementId: string;
  meetingId: string;
  companyId: string;
  expertProfileId: string;
  caseTitle: string;
  closedAt: Date;
  recipientId: string;
  consultationCount: number;
  reviewToken: string | undefined;
}): Promise<void> {
  const [company, profile] = await Promise.all([
    companiesRepository.findNameById(input.companyId),
    expertsRepository.findDisplayProfileById(input.expertProfileId),
  ]);
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);

  publishNotificationEvent('engagement.case_closed', {
    correlationId: input.engagementId + ':case_closed',
    engagementId: input.engagementId,
    meetingId: input.meetingId,
    recipientId: input.recipientId,
    expertProfileId: input.expertProfileId,
    clientCompanyName: company?.name ?? 'your company',
    expertPartyLabel: expertPartyDisplayName({
      type: profile?.type ?? 'freelancer',
      agencyName: agency?.name ?? null,
      firstName: expertUser?.firstName ?? null,
      lastName: expertUser?.lastName ?? null,
    }),
    caseTitle: input.caseTitle,
    closedDate: formatLongUtc(input.closedAt),
    closeReason: 'resolved',
    consultationCount: input.consultationCount,
    reviewToken: input.reviewToken,
  }).catch(() => {
    // publishNotificationEvent logs internally and never throws to the caller.
  });
}

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

    // POST-COMMIT. Nothing below may fail the close.
    const siblings = await meetingContextsRepository
      .listMeetingsForContext('case', engagementId)
      .catch(() => []);
    const { heldCount } = deriveConsultationOrdinal(
      siblings.map((row) => ({
        id: row.id,
        scheduledStart: row.scheduledStart,
        startedAt: row.startedAt,
        status: row.status,
        outcome: row.outcome,
      })),
      meetingId
    );

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
