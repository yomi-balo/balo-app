/**
 * BAL-390 (+ BAL-587) — review & rating capture analytics.
 *
 * ⚠ MIXED FILE. The `_SERVER_` constants (`REVIEW_SERVER_EVENTS`) stay SERVER-ONLY — every
 * one of them fires from a server surface: the two write events from the Server Action
 * write path (`applyReview`), the nudge event from the API's hourly review-nudge sweep.
 * They must NOT be added to `AllEvents` (the client union) nor to the
 * `apps/web/src/test/setup.ts` client `vi.mock('@/lib/analytics')` export list — that mock
 * is client-only, and adding a server constant to it would be misleading rather than
 * merely redundant.
 *
 * `REVIEW_EVENTS` (BAL-587) is the CLIENT namespace: `review_prompt_viewed` fires once per
 * mount from `EngagementRatingCard`, on every placement it mounts at (`recap`,
 * `project_workspace`, `case_surface`) — `end_of_call` has its own dedicated view event and
 * never reaches this one. Its registration is the same five-file path every
 * client family in this package follows — the events barrel, `types.ts`'s `AllEvents`, the
 * package `client/` allowlist, the `apps/web` client allowlist, and the `apps/web` test
 * `vi.mock` list.
 *
 * ⚠ NO REVIEW CONTENT AND NO TOKEN — on EITHER namespace. `has_body` is a boolean, never
 * the body; the raw magic-link token never appears in a property; `review_prompt_viewed`
 * carries no name and no body either. `distinct_id` is the reviewer's user id.
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
import type {
  EndOfCallReviewState,
  InAppReviewSurface,
  ReviewAuthMethod,
  ReviewSurface,
} from '@balo/shared/reviews';

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

// ── Client (browser `track`) ──────────────────────────────────────────────

export const REVIEW_EVENTS = {
  /** `EngagementRatingCard` rendered with loaded data — fired once per mount (BAL-587). */
  PROMPT_VIEWED: 'review_prompt_viewed',
} as const;

/**
 * Every in-app surface EXCEPT `end_of_call` — that surface already has its own dedicated
 * event, `END_OF_CALL_SERVER_EVENTS.VIEWED`, so `review_prompt_viewed` is never fired
 * there and this dimension never carries that value.
 */
export type ReviewPromptSurface = Exclude<InAppReviewSurface, 'end_of_call'>;

export interface ReviewEventMap {
  [REVIEW_EVENTS.PROMPT_VIEWED]: {
    surface: ReviewPromptSurface;
    state: EndOfCallReviewState['kind'];
    engagement_kind: ReviewEngagementKind;
  };
}
