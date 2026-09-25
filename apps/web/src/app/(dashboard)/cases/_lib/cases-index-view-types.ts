import type { CasesIndexCardState, CasesIndexWorkspaceType } from '@balo/analytics/events';
import type { MeetingLifecycleStatus } from '@balo/shared/meetings';

/**
 * BAL-567 — the `/cases` index's CLIENT-SAFE view model: types and constants only.
 *
 * ⚠⚠ NO RUNTIME IMPORT MAY BE ADDED HERE. Every import above is `import type`, so all are erased
 * at build and none drags `postgres` into a browser bundle (memory
 * `reference_balo_db_client_bundle_footgun`: a client component that VALUE-imports `@balo/db`
 * breaks `next build` with "can't resolve 'tls'"). Same posture as `up-next-view-types.ts` and
 * `case-view-types.ts`.
 *
 * ── ⚠⚠ WHAT MAY NEVER APPEAR IN A SHAPE BELOW ────────────────────────────────────────────────
 * No money (`rate_cents`, `balo_fee_bps`, any `*_cents` / `*_minor` figure), no fees, no
 * earnings, no email address (ADR-1044), no idempotency key, and NO MEETING SECRET
 * (`meetings.join_url`, `meetings.daily_room_name`). No `@balo/db` row type is a field of any
 * shape here — every view is plain projected data, projected SERVER-SIDE in
 * `build-cases-index-cards.ts`. TWO test files hold this, and they hold different halves:
 * `cases-index-view-types.test.ts` pins the two key TUPLES below exactly (and that this module
 * stays value-import-free), while `build-cases-index-cards.test.ts` compares the BUILT DTO's keys
 * against those tuples and walks it deeply for a denylist.
 *
 * ⚠ THE ONE PATH THAT IS HERE — `joinPath` — IS A ROUTE, NOT A CREDENTIAL. See its own note.
 */

/**
 * WHICH workspace's list. `= CasesIndexWorkspaceType`, the analytics dimension, so the rendered
 * surface and the event it reports can never disagree about what they are describing.
 *
 * ⚠ NOT A LENS AND NOT `activeMode`. It selects which list to show; it authorizes nothing
 * (ADR-1029). Side-dependent behaviour downstream is a `Record<CasesIndexSide, …>` LOOKUP, never
 * a `side === 'company'` branch — pinned by `invariants/cases-index-no-view-gate.test.ts`.
 */
export type CasesIndexSide = CasesIndexWorkspaceType;

/** Re-exported so a consumer needs ONE import for the whole index contract. */
export type { CasesIndexCardState };

/**
 * One mark on a case's consultation trail. DERIVED SERVER-SIDE from
 * `deriveCaseConsultationState`'s label (`caseTrailMark`), never re-derived in a component: a
 * second mapping would be a second opinion about what "held" means.
 *
 * ⚠ `unrecorded` IS ITS OWN MARK, NOT FOLDED INTO `missed`. `outcome_pending` is a meeting that
 * ENDED with no outcome stamped — legal in the database (`meeting_outcome_requires_ended` is
 * one-directional) — and calling it "missed" would accuse somebody of not showing up.
 */
export const CASE_TRAIL_MARKS = ['held', 'booked', 'cancelled', 'missed', 'unrecorded'] as const;
export type CaseTrailMark = (typeof CASE_TRAIL_MARKS)[number];

/**
 * One mark, with the consultation NUMBER it stands for.
 *
 * ⚠ THE ORDINAL IS CARRIED SO THE LIST HAS A STABLE REACT KEY THAT IS NOT AN ARRAY INDEX
 * (SonarCloud S6479 — an interpolated index is flagged too). It is genuine data, not a synthetic
 * handle: it is the consultation's 1-based position in the case, counted BEFORE the trail is
 * trimmed to its last few marks, so "the 7th consultation" keeps its number when older marks
 * scroll off. A meeting ID would have worked as a key too and is deliberately NOT used — no
 * meeting identifier crosses to this surface at all except the featured card's join path.
 */
export interface CaseTrailEntry {
  readonly ordinal: number;
  readonly mark: CaseTrailMark;
}

/**
 * ONE open case, crossing the RSC→client boundary.
 *
 * ⚠ EVERY FIELD IS ALREADY PRESENTATION-READY. The card renders it; it never computes a second
 * state from raw columns, because the index and the case page must agree on what a case is doing
 * and `selectCaseNudge` is the one function that decides that.
 */
export interface CasesIndexCardView {
  readonly engagementId: string;
  /** `/cases/{engagementId}` — every affordance on the card opens the case. */
  readonly href: string;
  readonly title: string;
  /**
   * WHICH of the eight states the card renders in — server-derived from `selectCaseNudge`.
   *
   * ⚠ `live` IS NEVER SET HERE. It is a function of the VIEWER's clock, so the featured card
   * derives it on the tick (`resolveFeaturedTiming`); a server-stamped `live` would be stale by
   * the time it painted and would differ between the server and client renders.
   */
  readonly cardState: CasesIndexCardState;
  /** Client side: the delivering expert (a person). Expert side: the client COMPANY. */
  readonly counterpartyName: string;
  /** Client side: the expert's agency, or `null` when they are independent. Expert side: `null`. */
  readonly counterpartyOrgLabel: string | null;
  /** Already through `getAvatarUrl` — an R2 key never reaches the client as one. */
  readonly counterpartyAvatarUrl: string | null;
  readonly counterpartyInitials: string;
  /** Product tag NAMES only — never a description or an icon URL. Bounded server-side. */
  readonly productTags: readonly string[];
  /** Oldest first, already trimmed to what the trail renders. */
  readonly trail: readonly CaseTrailEntry[];
  /** Distinct `ended` + `completed` consultations — the "{n} held" figure. */
  readonly heldCount: number;
  /** OPEN action items assigned to the VIEWER'S OWN side. */
  readonly actionItemsForYou: number;
  /**
   * Whether the thread carries inbound activity the viewer has not read.
   *
   * ⚠ A BOOLEAN, NOT A COUNT, AND THAT IS A DELIBERATE DEVIATION FROM THE DESIGN REFERENCE'S
   * "{n} new". The only batched read that exists (`listThreadSummaries`) answers
   * `latestInboundActivityAt` vs `lastReadAt`; the counting one (`unreadSummaryFor`) fires SEVEN
   * queries PER CONVERSATION, which is exactly the per-card read this index forbids.
   */
  readonly unread: boolean;
  readonly openedAtIso: string;
  /** The soonest still-expected consultation, or `null`. */
  readonly nextBookingStartIso: string | null;
  readonly nextBookingEndIso: string | null;
  /**
   * That meeting's lifecycle status — the third input `calendarJoinAffordanceVisible` needs, so
   * the featured card's Join window closes on a terminal status and not merely on the clock.
   * A LIFECYCLE LABEL, not a row: no `join_url`, no `daily_room_name`.
   */
  readonly nextBookingStatus: MeetingLifecycleStatus | null;
  /** The latest HELD consultation, for the quiet slot's "Last call {date}". */
  readonly lastCallAtIso: string | null;
  /** How many times a live reschedule proposal offers. `null` when there is none. */
  readonly proposalOptionCount: number | null;
  /**
   * WHO acted, for the four attributed states — `resolveActorLabel`'s output, resolved
   * server-side from NAME COLUMNS ONLY. `null` for the states nobody acted on.
   */
  readonly actorLabel: string | null;
  /**
   * `/experts/{username}`, or `null` — `expert_profiles.username` is NULLABLE, and a null one
   * means NO BUTTON rather than a link to `/experts/null`. Client side only.
   */
  readonly bookAgainHref: string | null;
  /**
   * `memberCallPath(meetingId)` for the FEATURED card's booking — `null` on every other card,
   * because only the featured card renders Join.
   *
   * ⚠⚠ NAVIGATED TO, NEVER RENDERED AS AN `href`. `JoinMeetingButton` is a `<button>` +
   * `globalThis.location.assign` so the meeting id never becomes a DOM attribute PostHog
   * autocapture or Sentry Session Replay can lift. `invariants/join-link-never-writes.test.ts`
   * scans this route for the `href={…joinPath…}` shape.
   */
  readonly joinPath: string | null;
  /** BAL-581 — whether `nextBooking`'s call room is ready (the repository's SQL twin of
   *  `isMeetingVenueReady`), `null` when there is none. Only the featured card reads it. A boolean
   *  only — never the room name or join url. */
  readonly nextBookingRoomReady: boolean | null;
}

export const CASES_INDEX_CARD_VIEW_KEYS = [
  'engagementId',
  'href',
  'title',
  'cardState',
  'counterpartyName',
  'counterpartyOrgLabel',
  'counterpartyAvatarUrl',
  'counterpartyInitials',
  'productTags',
  'trail',
  'heldCount',
  'actionItemsForYou',
  'unread',
  'openedAtIso',
  'nextBookingStartIso',
  'nextBookingEndIso',
  'nextBookingStatus',
  'lastCallAtIso',
  'proposalOptionCount',
  'actorLabel',
  'bookAgainHref',
  'joinPath',
  'nextBookingRoomReady',
] as const satisfies readonly (keyof CasesIndexCardView)[];

/** `resolved` (a client closed it) or `auto_inactive` (the sweep did). */
export type CasesIndexCloseReason = 'resolved' | 'auto_inactive';

/** ONE resolved case. Deliberately thinner: no trail, no unread, no tags — nothing to act on. */
export interface CasesIndexResolvedRowView {
  readonly engagementId: string;
  readonly href: string;
  readonly title: string;
  readonly counterpartyName: string;
  readonly counterpartyOrgLabel: string | null;
  readonly closedAtIso: string;
  /** `null` on a row closed before the reason column existed — the copy then stays neutral. */
  readonly closeReason: CasesIndexCloseReason | null;
  readonly heldCount: number;
  /** Client side only, and `null` when the expert has no username. */
  readonly bookAgainHref: string | null;
}

export const CASES_INDEX_RESOLVED_ROW_VIEW_KEYS = [
  'engagementId',
  'href',
  'title',
  'counterpartyName',
  'counterpartyOrgLabel',
  'closedAtIso',
  'closeReason',
  'heldCount',
  'bookAgainHref',
] as const satisfies readonly (keyof CasesIndexResolvedRowView)[];

/**
 * ⚠ COMPILE-TIME REVERSE CHECKS, MADE REAL (the `ASSERT_UP_NEXT_KEYS_COMPLETE` idiom). A key
 * added to either interface but not to its key tuple makes the corresponding `_Missing…` alias
 * non-`never`, and the literal `true` below then fails to `satisfy` the resulting `never` — a
 * genuine `tsc` error rather than a claim in a comment. Exported and referenced by
 * `cases-index-view-types.test.ts` so neither can rot back into "declared but unused".
 */
type _MissingCardKey = Exclude<
  keyof CasesIndexCardView,
  (typeof CASES_INDEX_CARD_VIEW_KEYS)[number]
>;
export const ASSERT_CASES_INDEX_CARD_KEYS_COMPLETE = true satisfies _MissingCardKey extends never
  ? true
  : never;

type _MissingResolvedKey = Exclude<
  keyof CasesIndexResolvedRowView,
  (typeof CASES_INDEX_RESOLVED_ROW_VIEW_KEYS)[number]
>;
export const ASSERT_CASES_INDEX_RESOLVED_KEYS_COMPLETE =
  true satisfies _MissingResolvedKey extends never ? true : never;

/**
 * The OPEN list's keyset cursor, as it crosses to the client and back through the Server Action.
 *
 * ⚠ IT CARRIES NO PARTY ID, AND THAT IS THE POINT. `loadMoreOpenCases` re-derives the scope from
 * the SESSION on every call and re-runs the participation gate; a `companyId` on the wire would
 * be a client-supplied tenancy key.
 */
export interface CasesIndexCursorDTO {
  readonly bucket: number;
  readonly sortRank: number;
  readonly id: string;
}

/** The RESOLVED list's keyset cursor. Same no-party-id rule as {@link CasesIndexCursorDTO}. */
export interface ResolvedCasesCursorDTO {
  readonly closedAtEpoch: number;
  readonly id: string;
}

/** Which empty state the ready-but-empty list renders. Resolved server-side. */
export type CasesIndexEmptyKind = 'no_cases' | 'expert_setup_incomplete';

export interface CasesIndexReadyView {
  readonly kind: 'ready';
  readonly side: CasesIndexSide;
  /** The workspace company's name — the client description and the lock copy name it. */
  readonly companyName: string;
  /** The soonest booked case, promoted to the ticket card. `null` when nothing is booked. */
  readonly featured: CasesIndexCardView | null;
  /** Every other open case on this page, in the repository's order. */
  readonly open: readonly CasesIndexCardView[];
  readonly openHasMore: boolean;
  readonly openCursor: CasesIndexCursorDTO | null;
  /** `count(*)` over the WHOLE scope, not this page — the section heading states the total. */
  readonly openCount: number;
  readonly resolvedCount: number;
  /** `null` when the list is non-empty; otherwise which empty state to render. */
  readonly empty: CasesIndexEmptyKind | null;
}

/**
 * ⚠ `no_access` IS A FAIL-CLOSED BRANCH, NOT AN EMPTY LIST. A company member whose role does not
 * carry `PARTICIPATE` can open NO case (`authorizeEngagementConversation` denies
 * `member_without_participate` outright), so showing them an empty list would be a lie. See D9
 * for why the branch exists even though no shipped company role can currently reach it.
 */
export type CasesIndexData =
  | CasesIndexReadyView
  | { readonly kind: 'no_access'; readonly companyName: string }
  | { readonly kind: 'error' };

/** The "show more" Server Actions' result shape, for both lists. */
export type LoadMoreOpenCasesResult =
  | {
      readonly success: true;
      readonly rows: readonly CasesIndexCardView[];
      readonly hasMore: boolean;
      readonly nextCursor: CasesIndexCursorDTO | null;
    }
  | { readonly success: false; readonly error: string };

export type LoadMoreResolvedCasesResult =
  | {
      readonly success: true;
      readonly rows: readonly CasesIndexResolvedRowView[];
      readonly hasMore: boolean;
      readonly nextCursor: ResolvedCasesCursorDTO | null;
    }
  | { readonly success: false; readonly error: string };
