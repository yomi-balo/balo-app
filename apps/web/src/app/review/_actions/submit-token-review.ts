'use server';

import 'server-only';

import { headers } from 'next/headers';
import { z } from 'zod';
import { reviewInviteTokensRepository } from '@balo/db';
import { REVIEW_BODY_MAX, RATING_MAX, RATING_MIN, isRating } from '@balo/shared/reviews';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { clientIp, hashesMatch, sha256Hex } from '@/lib/magic-link';
import { log } from '@/lib/logging';
import { REVIEW_SUBMIT_FAILED } from '@/lib/reviews/messages';
import { applyReview } from './review-write-shared';

/**
 * submitTokenReviewAction — the UNAUTHENTICATED, token-identified review write
 * (BAL-390 §6.3).
 *
 * ⚠ REVIEWER NOTE — this action calls NEITHER `requireUser()` NOR
 * `requireOnboardedUser()`, and that is correct, not an oversight. The reviewer is
 * logged out: they arrived from an email and authenticate by presenting a ≥256-bit
 * bearer token. Verified against `apps/web/src/invariants/onboarding-mutation-gate.test.ts`
 * — it greps for a bare `requireUser(` call, which this file does not make, so NO
 * allowlist entry is needed. The gate that DOES apply (`PARTICIPATE` on the
 * engagement's company, evaluated against the token's subject inside {@link applyReview})
 * is strictly narrower than onboarding.
 *
 * ⚠ THE TOKEN NAMES THE REVIEWER; IT IS NOT AUTHORIZATION. Holding the token proves
 * only WHO a submission is attributed to. The capability gate runs on every single
 * submit — see the `review-write-shared` docblock for why that is also the revocation
 * channel.
 *
 * ⚠ EVERY FAILURE RETURNS THE SAME OPAQUE SHAPE. Expired, revoked, wrong, rate-limited,
 * not-a-member and a genuine DB fault are indistinguishable to the caller. Distinguishing
 * them would turn this action into an oracle for "does this engagement exist" and "is
 * this person still employed there".
 *
 * ⚠ POST-ONLY BY CONSTRUCTION. A Server Action requires the `Next-Action` header and a
 * build-time action id, so it cannot be triggered by navigation, prefetch, an `<img>`,
 * or a scanner rewriting the emailed URL. That is what makes "the star link prefills, it
 * never writes" true rather than aspirational.
 */

/**
 * ⚠ THE FAILURE COPY LIVES IN `@/lib/reviews/messages`, NOT HERE — AND MUST NOT MOVE BACK.
 * A `'use server'` module may only export async functions, so a plain `export const`
 * string in this file fails `next build` with *"Only async functions are allowed to be
 * exported in a 'use server' file"* — invisibly to tsc, eslint and vitest, because it is
 * a bundler rule. It broke CI on PR #191. Type-only exports stay fine.
 */

/**
 * `.strict()`: any unknown key fails the parse outright. `body` is optional and trimmed;
 * an empty string after trimming is stored as `null` (the DB CHECK
 * `review_body_nonempty_when_present` rejects a whitespace-only body).
 */
const submitTokenReviewSchema = z
  .object({
    token: z.string().min(20).max(200),
    rating: z.number().int().min(RATING_MIN).max(RATING_MAX),
    body: z.string().trim().max(REVIEW_BODY_MAX).optional(),
  })
  .strict();

export interface SubmitTokenReviewInput {
  token: string;
  rating: number;
  body?: string;
}

export type SubmitTokenReviewResult =
  | { success: true; created: boolean }
  | { success: false; error: string };

/** The IP-keyed limiter: 10 submits a minute from one hot instance. */
const IP_LIMIT = { max: 10, windowMs: 60_000 } as const;

/**
 * The TOKEN-keyed limiter: 10 submits per 10 minutes against one KNOWN token. This is
 * the important half — it caps abuse of a token that has leaked (a forwarded email, a
 * shared inbox) independently of the attacker's IP, which the IP limiter cannot.
 */
const TOKEN_LIMIT = { max: 10, windowMs: 600_000 } as const;

export async function submitTokenReviewAction(
  input: SubmitTokenReviewInput
): Promise<SubmitTokenReviewResult> {
  const parsed = submitTokenReviewSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: REVIEW_SUBMIT_FAILED };
  }
  const { token, rating, body } = parsed.data;
  // Narrows the Zod-proven range to the `Rating` literal union WITHOUT an assertion.
  if (!isRating(rating)) {
    return { success: false, error: REVIEW_SUBMIT_FAILED };
  }

  // BOTH limiters run BEFORE the database is touched. The IP one runs before the hash
  // as well; the token-keyed one necessarily derives its key from the hash, so the hash
  // is computed once here and reused for the lookup below.
  const headerList = await headers();
  if (!checkMemoryLimit(`review-submit-ip:${clientIp(headerList)}`, IP_LIMIT)) {
    return { success: false, error: REVIEW_SUBMIT_FAILED };
  }
  const tokenHash = sha256Hex(token);
  if (!checkMemoryLimit(`review-submit-tok:${tokenHash.slice(0, 16)}`, TOKEN_LIMIT)) {
    return { success: false, error: REVIEW_SUBMIT_FAILED };
  }

  const row = await reviewInviteTokensRepository.findLiveByTokenHash(tokenHash);
  if (row === undefined || !hashesMatch(tokenHash, row.tokenHash)) {
    // A hash PREFIX only — enough to correlate an incident, never enough to replay.
    log.info('Review link not active on submit', { tokenHashPrefix: tokenHash.slice(0, 8) });
    return { success: false, error: REVIEW_SUBMIT_FAILED };
  }

  const result = await applyReview({
    engagementId: row.engagementId,
    reviewerUserId: row.reviewerUserId,
    rating,
    body: body === undefined || body.length === 0 ? null : body,
    surface: 'email',
    authMethod: 'magic_link',
  });

  if (!result.ok) {
    log.warn('Review write refused on the magic-link path', {
      engagementId: row.engagementId,
      userId: row.reviewerUserId,
      reason: result.error,
    });
    return { success: false, error: REVIEW_SUBMIT_FAILED };
  }

  // `recordAccess` is deliberately NOT re-stamped here: the review row itself is the
  // record that a submit happened, and `access_count` means "the link was opened".
  return { success: true, created: result.created };
}
