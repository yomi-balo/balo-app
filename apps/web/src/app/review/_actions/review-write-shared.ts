import 'server-only';

import { engagementsRepository, reviewsRepository } from '@balo/db';
import type { Rating, ReviewAuthMethod, ReviewSurface } from '@balo/shared/reviews';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { trackServerAndFlush, REVIEW_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';

/**
 * review-write-shared — THE single review write path (BAL-390 §6.3).
 *
 * NOT a `'use server'` module: it is a plain server-only internal shared by the two
 * Server Actions that wrap it (the `engagement-lifecycle-shared.ts` pattern), so the
 * capability gate, the IDOR closure and the analytics split exist in exactly ONE place
 * and cannot drift between the magic-link path and the signed-in path.
 *
 * ⚠ THE GATE (D10): `hasCapability(actor, PARTICIPATE, { companyId })` resolved from
 * `@/lib/authz` — the ASYNC, `server-only` seam that reads the actor's LIVE membership.
 * NOT `@balo/shared/authz`, which is the pure role→capability map with no membership
 * lookup. Never gate on `activeMode`, `platformRole` or a lens (ADR-1029).
 *
 * ⚠ THE DELIVERING EXPERT FAILS NATURALLY. They hold no membership in the CLIENT
 * company, so `getMemberRole` returns `undefined` and the gate denies. "An expert cannot
 * rate themselves" is structural here, not a special case — do not add one.
 *
 * ⚠ IDOR CLOSURE — none of the three identities is ever read from a form field:
 *   · `engagementId`    — from the resolved token row, or the gated action argument.
 *   · `reviewerUserId`  — from the token row, or `requireOnboardedUser().id`.
 *   · `expertProfileId` — ALWAYS server-derived from the engagement, right here.
 *
 * ⚠ NEITHER THE BODY NOR THE TOKEN IS EVER LOGGED OR TRACKED. The analytics payload
 * carries `has_body`, never the text.
 */

/**
 * Why a write did not happen. Callers collapse ALL of these to one opaque, identical
 * user-facing failure — the magic-link path must never become an oracle for "this
 * engagement exists but you are not a member of it".
 */
export type ReviewWriteError = 'not_found' | 'forbidden' | 'failed';

export interface ApplyReviewInput {
  engagementId: string;
  /** The person the review is attributed to. Token subject, or the signed-in user. */
  reviewerUserId: string;
  rating: Rating;
  /** PLAIN TEXT, already trimmed by the caller's Zod. `null` when they wrote nothing. */
  body: string | null;
  surface: ReviewSurface;
  authMethod: ReviewAuthMethod;
}

export type ApplyReviewResult =
  | { ok: true; created: boolean }
  | { ok: false; error: ReviewWriteError };

/** The two engagement kinds that are reviewable — `package` / `retainer` are unbuilt. */
type ReviewableKind = 'project' | 'case';

/**
 * Narrow the engagement type discriminator to a reviewable kind. `package` and
 * `retainer` are DECLARED-BUT-UNBUILT labels on `engagement_type` (no child table, no
 * writer), so this returns `undefined` for them rather than inventing an analytics
 * dimension — the same treatment `reviewsRepository.findLandingContext` gives them.
 */
function reviewableKind(engagementType: string): ReviewableKind | undefined {
  if (engagementType === 'project' || engagementType === 'case') {
    return engagementType;
  }
  return undefined;
}

/**
 * Write (or replace) `reviewerUserId`'s review of the engagement's delivering expert.
 *
 * Order of operations is load-bearing: resolve the engagement, THEN gate, THEN derive
 * the expert, THEN write. The gate runs on EVERY call — including every magic-link
 * submit — which is also this feature's revocation channel: a departed reviewer's
 * soft-deleted `company_members` row makes every one of their outstanding 30-day tokens
 * stop writing instantly, with no revocation step anywhere.
 */
export async function applyReview(input: ApplyReviewInput): Promise<ApplyReviewResult> {
  const engagement = await engagementsRepository.findById(input.engagementId);
  if (engagement === undefined) {
    return { ok: false, error: 'not_found' };
  }

  const engagementKind = reviewableKind(engagement.engagementType);
  if (engagementKind === undefined) {
    log.warn('Review write on a non-reviewable engagement type', {
      engagementId: input.engagementId,
      engagementType: engagement.engagementType,
    });
    return { ok: false, error: 'not_found' };
  }

  const allowed = await hasCapability({ id: input.reviewerUserId }, CAPABILITIES.PARTICIPATE, {
    companyId: engagement.companyId,
  });
  if (!allowed) {
    return { ok: false, error: 'forbidden' };
  }

  try {
    const { created, ratingCount } = await reviewsRepository.upsert({
      engagementId: input.engagementId,
      reviewerUserId: input.reviewerUserId,
      // SERVER-DERIVED, always. Never accepted from the caller, never from a form field.
      expertProfileId: engagement.expertProfileId,
      rating: input.rating,
      body: input.body,
      surface: input.surface,
      authMethod: input.authMethod,
    });

    trackServerAndFlush(created ? REVIEW_SERVER_EVENTS.SUBMITTED : REVIEW_SERVER_EVENTS.UPDATED, {
      rating: input.rating,
      has_body: input.body !== null,
      auth_method: input.authMethod,
      surface: input.surface,
      engagement_kind: engagementKind,
      distinct_id: input.reviewerUserId,
    });

    // ⚠ `ratingCount` IS DRIFT TELEMETRY (BAL-422), not decoration. It is the value the
    // in-transaction recompute actually COMMITTED to `expert_profiles.rating_count`, so an
    // operator can compare the stored aggregate against the review rows from the log alone.
    // It counts ENGAGEMENTS REVIEWED, never review rows — the same quantity every surface
    // renders in parentheses. NOT tracked to PostHog: it is an operational number, and the
    // review analytics events are deliberately keyed on the submission, not on the expert.
    log.info('Review submitted', {
      engagementId: input.engagementId,
      userId: input.reviewerUserId,
      authMethod: input.authMethod,
      surface: input.surface,
      created,
      ratingCount,
    });

    return { ok: true, created };
  } catch (error) {
    log.error('Review write failed', {
      engagementId: input.engagementId,
      userId: input.reviewerUserId,
      authMethod: input.authMethod,
      surface: input.surface,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'failed' };
  }
}
