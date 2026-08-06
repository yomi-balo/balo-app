'use server';

import 'server-only';

import { z } from 'zod';
import { REVIEW_BODY_MAX, RATING_MAX, RATING_MIN, isRating } from '@balo/shared/reviews';
import { requireOnboardedUser } from '@/lib/auth/session';
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
 * ⚠ ZERO CALLERS SHIP IN BAL-390. This is a declared seam with a test, not dead code:
 * the ticket ships the primitive (schema + repository + resolver + write path) and
 * BAL-389 mounts the UI on top of it.
 */

// ── DRAFT COPY — pending MJ sign-off. Friendly, non-leaking, returned verbatim for
//    the caller to toast.
export const REVIEW_NOT_SIGNED_IN = 'Please sign in and try again.';
export const REVIEW_INVALID_REQUEST = 'Invalid request.';
/** `forbidden` collapses to this too, so the action is never an existence oracle. */
export const REVIEW_ENGAGEMENT_NOT_FOUND = 'This engagement could not be found.';
export const REVIEW_GENERIC_FAILURE = 'Something went wrong. Please try again.';

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
