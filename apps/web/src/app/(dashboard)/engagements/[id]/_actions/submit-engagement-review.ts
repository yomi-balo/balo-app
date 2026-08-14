'use server';

import 'server-only';

import { z } from 'zod';
import { REVIEW_BODY_MAX, RATING_MAX, RATING_MIN, isRating } from '@balo/shared/reviews';
import { requireOnboardedUser } from '@/lib/auth/session';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import {
  REVIEW_ENGAGEMENT_NOT_FOUND,
  REVIEW_GENERIC_FAILURE,
  REVIEW_INVALID_REQUEST,
  REVIEW_NOT_SIGNED_IN,
} from '@/lib/reviews/messages';
import { applyReview } from '@/app/review/_actions/review-write-shared';

/**
 * submitEngagementReviewAction — the SIGNED-IN review write (BAL-390 D3).
 *
 * The sibling of `submitTokenReviewAction`: same {@link applyReview} write path, same
 * capability gate, different way of establishing WHO is reviewing. Here it is the
 * iron-session user, so `authMethod` is `'session'`.
 *
 * ⚠ `requireOnboardedUser()`, NOT bare `requireUser()` — mandatory for a mutating
 * Server Action and mechanically enforced by
 * `apps/web/src/invariants/onboarding-mutation-gate.test.ts`, whose read-only allowlist
 * this must never join.
 *
 * ⚠ `surface` IS A PARAMETER, not a constant, and that is the whole point of the seam:
 * BAL-389 mounts the end-of-call control and passes `'end_of_call'`; BAL-388's recap
 * surface passes `'recap'` and needs no change here. `'email'` is deliberately NOT
 * accepted — that surface is the magic-link landing, which authenticates by token.
 *
 * ⚠ IDOR-SAFE WITHOUT A LENS LOOKUP: the only identity the caller supplies is the
 * engagement id, and {@link applyReview} gates it with
 * `hasCapability(PARTICIPATE, { companyId: engagement.companyId })` before deriving the
 * expert from the engagement itself. A signed-in stranger passing someone else's
 * engagement id is denied there.
 *
 * ⚠ IT IS MOUNTED. BAL-390 shipped it with zero callers; BAL-389 then mounted it from
 * the end-of-call rating block (`rating-block.tsx`, which calls it with
 * `surface: 'end_of_call'`). Anything reasoning about this file as an unreachable seam is
 * out of date — including, until BAL-422's fix round, the note that used to sit here.
 *
 * ⚠ RATE LIMITED, AND NOT ONLY FOR ABUSE-OF-CONTENT REASONS. See {@link SUBMIT_LIMIT}.
 */

// ⚠ THE FAILURE COPY LIVES IN `@/lib/reviews/messages`, NOT HERE — AND MUST NOT MOVE BACK.
//   A `'use server'` module may only export async functions; a plain `export const` string
//   here fails `next build` with "Only async functions are allowed to be exported in a
//   'use server' file". These four strings previously lived in this file and built green
//   ONLY because this action had no callers, so it never entered the client graph to be
//   checked. Its sibling `submit-token-review.ts` — same violation, but reachable from the
//   landing form — broke CI on PR #191. This file IS in the client graph now (BAL-389
//   mounted it), so moving the strings out is what keeps it building.
//
// ⚠ FOR THE SAME REASON, `SUBMIT_LIMIT` BELOW IS NOT EXPORTED. It is a `const` in a
//   `'use server'` module; exporting it would fail `next build` — and now that this file
//   is reachable, it would fail LOUDLY rather than silently.

/**
 * 10 submits per 10 minutes per (reviewer, engagement) — the same shape and budget as the
 * magic-link path's token-keyed limiter, so the two review write paths cannot be capped
 * differently by accident.
 *
 * ⚠ WHY AN AUTHENTICATED, IDEMPOTENT-ISH ACTION NEEDS ONE AT ALL. A review is REVISABLE
 * indefinitely: every repeat call from the same signed-in user on the same engagement is a
 * LEGITIMATE write, so nothing else in this path caps the rate. Each one takes a row lock
 * on `expert_profiles` inside the write transaction (see `recomputeRatingAggregate`), which
 * makes an unbounded revise loop a targeted latency attack on ONE expert's writes rather
 * than a content-spam problem. That is the reason for the key: it is deliberately NOT
 * IP-keyed — the actor here is authenticated, and a per-IP bucket would let one user with
 * several IPs through while penalising an office NAT.
 *
 * ⚠ BEST-EFFORT AND PER-INSTANCE, like every other `checkMemoryLimit` caller: a
 * module-level `Map` is not shared across Vercel lambdas. It blunts a hot loop; it is not
 * a global guarantee, and the correctness of the aggregate does not depend on it.
 */
const SUBMIT_LIMIT = { max: 10, windowMs: 600_000 } as const;

const submitEngagementReviewSchema = z
  .object({
    engagementId: z.uuid(),
    rating: z.number().int().min(RATING_MIN).max(RATING_MAX),
    body: z.string().trim().max(REVIEW_BODY_MAX).optional(),
    surface: z.enum(['end_of_call', 'recap']),
  })
  .strict();

export interface SubmitEngagementReviewInput {
  engagementId: string;
  rating: number;
  body?: string;
  surface: 'end_of_call' | 'recap';
}

export type SubmitEngagementReviewResult =
  | { success: true; created: boolean }
  | { success: false; error: string };

export async function submitEngagementReviewAction(
  input: SubmitEngagementReviewInput
): Promise<SubmitEngagementReviewResult> {
  let reviewerUserId: string;
  try {
    reviewerUserId = (await requireOnboardedUser()).id;
  } catch {
    return { success: false, error: REVIEW_NOT_SIGNED_IN };
  }

  const parsed = submitEngagementReviewSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: REVIEW_INVALID_REQUEST };
  }
  const { engagementId, rating, body, surface } = parsed.data;
  // Narrows the Zod-proven range to the `Rating` literal union WITHOUT an assertion.
  if (!isRating(rating)) {
    return { success: false, error: REVIEW_INVALID_REQUEST };
  }

  // ⚠ AFTER the parse (so the key is built from validated input) and BEFORE the database is
  // touched (so a throttled caller costs no query and takes no lock). See {@link SUBMIT_LIMIT}.
  if (
    !checkMemoryLimit(`review-submit-engagement:${reviewerUserId}:${engagementId}`, SUBMIT_LIMIT)
  ) {
    // Deliberately the GENERIC failure, not a distinct "slow down" — this action is reached
    // from a signed-in UI where the honest answer to a burst is "that didn't go through",
    // and a distinguishable rate-limit reply is a signal worth not handing out.
    return { success: false, error: REVIEW_GENERIC_FAILURE };
  }

  const result = await applyReview({
    engagementId,
    reviewerUserId,
    rating,
    body: body === undefined || body.length === 0 ? null : body,
    surface,
    authMethod: 'session',
  });

  if (!result.ok) {
    return {
      success: false,
      error: result.error === 'failed' ? REVIEW_GENERIC_FAILURE : REVIEW_ENGAGEMENT_NOT_FOUND,
    };
  }

  return { success: true, created: result.created };
}
