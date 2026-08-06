/**
 * BAL-390 — review & rating capture analytics.
 *
 * SERVER-ONLY. Every one of these fires from a server surface: the two write events from
 * the Server Action write path (`applyReview`), the nudge event from the API's hourly
 * review-nudge sweep. They must NOT be added to `AllEvents` (the client union) nor to the
 * `apps/web/src/test/setup.ts` client `vi.mock('@/lib/analytics')` export list — that mock
 * is client-only, and adding a server constant to it would be misleading rather than
 * merely redundant.
 *
 * ⚠ NO REVIEW CONTENT AND NO TOKEN. `has_body` is a boolean, never the body; the raw
 * magic-link token never appears in a property. `distinct_id` is the reviewer's user id.
 *
 * ⚠ Deliberately NO landing-view event. The `/review/{token}` page is fetched
 * unsolicited by Gmail's link proxy, Microsoft Defender Safe Links detonation and MDM
 * prefetch, so an outbound capture on GET would corrupt the funnel and cannot be capped
 * by a DB-side limiter. Opens are visible only as the (honestly scanner-inflated)
 * `review_invite_tokens.access_count`.
 *
 * ⚠ NAMING: `review_*` here always means the STAR RATING. BAL-338's
 * `engagement.review_reminder` ("review the delivered work before it auto-accepts") is a
 * different thing entirely and has no events in this file.
 */
import type { ReviewAuthMethod, ReviewSurface } from '@balo/shared/reviews';

export const REVIEW_SERVER_EVENTS = {
  /** A review row was newly INSERTED (the upsert's create branch). */
  SUBMITTED: 'review_submitted',
  /** An existing live review was rewritten in place (the upsert's update branch). */
  UPDATED: 'review_updated',
  /** The sweep published a `review.reminder` for one reviewer at one cadence step. */
  NUDGE_SENT: 'review_nudge_sent',
} as const;

/** Which side of the engagement supertype was reviewed. */
export type ReviewEngagementKind = 'project' | 'case';

/**
 * Shared by `review_submitted` and `review_updated` — the two branches of one upsert,
 * split into two events only so created-vs-edited is answerable without a property
 * filter. One declaration, so the pair cannot drift (and so the two near-identical
 * shapes are not duplicated source).
 */
export interface ReviewWriteProperties {
  rating: number;
  /** Whether a body was written — NEVER the body itself. */
  has_body: boolean;
  /** HOW the writer authenticated: an iron-session request vs a magic-link bearer. */
  auth_method: ReviewAuthMethod;
  /** WHERE it was captured — orthogonal to `auth_method`. */
  surface: ReviewSurface;
  engagement_kind: ReviewEngagementKind;
  /** The reviewer's user id. */
  distinct_id: string;
}

export interface ReviewServerEventMap {
  [REVIEW_SERVER_EVENTS.SUBMITTED]: ReviewWriteProperties;
  [REVIEW_SERVER_EVENTS.UPDATED]: ReviewWriteProperties;
  [REVIEW_SERVER_EVENTS.NUDGE_SENT]: {
    /** 1 = +24h, 2 = +7d. There is no step 3 — the band math forbids one. */
    cadence_step: 1 | 2;
    engagement_kind: ReviewEngagementKind;
    /** The reviewer's user id (one publish per recipient, never a fan-out). */
    distinct_id: string;
  };
}
