/**
 * BAL-408 / ADR-1044 — guest participation analytics.
 *
 * SERVER-ONLY. Every producer is a server surface: the `apps/api` invite / remove /
 * admit / deny routes, plus the `apps/web` `/join/[token]` landing, which is an RSC. They
 * MUST NOT be added to `AllEvents` (the client union) nor to the
 * `apps/web/src/test/setup.ts` client `vi.mock('@/lib/analytics')` export list — that mock
 * is client-only, and adding a server constant to it would be misleading rather than merely
 * redundant. The `REVIEW_SERVER_EVENTS` / `MEETING_SERVER_EVENTS` precedent.
 *
 * ⚠ REGISTRATION IS FOUR FILES, NOT THREE. CLAUDE.md's checklist omits
 * `packages/analytics/src/server/index.ts`, and `apps/api` imports from
 * `@balo/analytics/server` ONLY — so skipping that re-export leaves these constants
 * unimportable from the app that emits most of them, and the failure lands in `apps/api`'s
 * typecheck rather than here (a check that compiles only this package cannot see a re-export
 * nobody wrote). Its co-located guard tests run via `npx vitest run packages/analytics`.
 *
 * ⚠ THIS PACKAGE **DOES** HAVE A `typecheck` SCRIPT AS OF BAL-132, and that is load-bearing
 * for the type-level assertions in `guest.test.ts` / `meeting.test.ts`. It previously had NO
 * `scripts` block at all, so root `pnpm typecheck` (`turbo run typecheck check-types`) never
 * reached this package and Vitest transpiles via esbuild WITHOUT type checking — meaning two
 * tests that described themselves as "COMPILE-TIME assertions" were compiled by nothing.
 *
 * ⚠⚠ NO EMAIL ADDRESSES, NO DOMAINS, NO NAMES, NO TOKENS — EVER. The whole feature is about
 * external people, so the temptation is real and the rule is absolute. `same_domain` is the
 * derived boolean that answers the product question ("did the scope widen because they are
 * a colleague?") without recording anything about the address; the `share.ts` precedent
 * records the domain itself, and this deliberately records less.
 *
 * ⚠ `guest_invite_opened`'s `distinct_id` IS `meeting_guests.id`, NOT A USER ID — a guest
 * has none. It is a stable pseudonymous handle that becomes joinable to a real person only
 * if BAL-345's (currently inert) domain auto-join ever writes `converted_to_user_id`.
 *
 * ⚠ ONE EVENT IS DELIBERATELY **NOT** DECLARED HERE, because an analytics constant with no
 * producer is a FALSE PostHog signal — a funnel step that can never fire reads as 100%
 * drop-off, and the exact-key-set guard in `guest.test.ts` would pin it forever:
 *   · `guest_converted_to_member` `{ days_since_meeting }` → **BAL-489** (the guest→user
 *     linkage writer split out of BAL-439; re-pointed from BAL-345, which owned the inert
 *     domain-auto-join arm this constant originally reserved against). Nothing writes
 *     `converted_to_user_id` yet.
 * The shape is written out above so that ticket adds it verbatim.
 *
 * ⚠ `guest_joined` WAS ON THAT LIST UNTIL BAL-132 AND HAS NOW LANDED, VERBATIM — the shape
 * this docblock reserved for it (`{ party, join_method, admitted }`) is exactly the shape
 * declared below, and it fires from `joinMeetingAsGuest` on every successful Daily token
 * mint. The discipline held: the constant arrived WITH its producer, in the same PR.
 *
 * ⚠ `guest_recap_viewed` LANDED THE SAME WAY (BAL-439, ADR-1046-adjacent ruling R12) — the
 * guest recap page (`app/join/[token]/recap/[meetingId]/page.tsx`) fires it on a SUCCESSFUL
 * render only; a denial keyed on a crafted token would itself be an enumeration signal. No
 * PII, no counterparty identity: `access_scope` is the grant, `is_own_meeting` and
 * `summary_state` describe what the reader saw, `days_since_meeting` (fix-round-1 / S6) is the
 * floored day count from the meeting to this open, and `distinct_id` is `meeting_guests.id` —
 * the same pseudonymous handle `guest_invite_opened` already uses, never a `users.id` a guest
 * does not have.
 */
import type {
  GuestAccessScopeLabel,
  MeetingContextTypeLabel,
  MeetingGuestInviteChannelLabel,
  MeetingGuestSide,
  MeetingParticipationRoleLabel,
} from '@balo/shared/meetings';

export const GUEST_SERVER_EVENTS = {
  /** A host admitted a waiting guest. ⚠ INERT until BAL-132 produces a `pending` row. */
  GUEST_ADMITTED: 'guest_admitted',
  /** A host denied a waiting guest. ⚠ INERT for the same reason. */
  GUEST_DENIED: 'guest_denied',
  /** The `/join/{token}` landing resolved a LIVE token and rendered. */
  GUEST_INVITE_OPENED: 'guest_invite_opened',
  /** One guest row committed. Emitted once PER GUEST, not once per batch. */
  GUEST_INVITED: 'guest_invited',
  /**
   * BAL-132 — a guest Daily meeting token was successfully MINTED, i.e. the guest actually
   * got into the room. ⚠ A MINT EVENT, NOT A UNIQUE-VISITOR ONE — see the map entry.
   */
  GUEST_JOINED: 'guest_joined',
  /**
   * BAL-436 — a host re-sent the join link to an ADMITTED-but-never-arrived guest, ROTATING
   * their credential. Fires from `apps/api`'s `resendGuestJoinLink`, which is its only
   * producer (the constant arrives WITH it, per this module's discipline).
   */
  GUEST_LINK_RESENT: 'guest_link_resent',
  /**
   * BAL-439 (R12) — the guest recap page rendered SUCCESSFULLY. Fires from
   * `app/join/[token]/recap/[meetingId]/page.tsx`, its only producer.
   */
  GUEST_RECAP_VIEWED: 'guest_recap_viewed',
  /** A guest's access was revoked. */
  GUEST_REMOVED: 'guest_removed',
} as const;

/**
 * HOW the guest got their credential — BAL-132.
 *
 * ⚠ DERIVED FROM THE PERSISTED `meeting_guests.invite_channel`, NEVER FROM REQUEST INPUT.
 * `email` → `magic_link` (an invite, trust-by-default, `pre_admitted`); `link` → `link_share`
 * (a forwarded link, hence the lobby queue). It is 1:1 with the channel BY CONSTRUCTION, and
 * that is exactly why `guest_joined` does NOT also carry an `invite_channel` property: two
 * spellings of one fact on one event is worse than either alone, because they can be filtered
 * against each other and disagree in a dashboard.
 *
 * ⚠ THE OTHER SIDE OF THAT RULING: `guest_admitted` / `guest_denied` DO carry
 * `invite_channel`, because those two have no other discriminator at all.
 */
export type GuestJoinMethod = 'magic_link' | 'link_share';

/**
 * WHERE the invite was composed. ⚠ THE FIELD THIS WHOLE EVENT SET EXISTS TO MEASURE, and
 * the only part of the invite contract that differs between the three consuming surfaces
 * (BAL-400 booking confirm, BAL-421 case surface, BAL-132 in-call). Required on the wire.
 */
export type GuestInviteEntryPoint = 'booking_confirm' | 'case_surface' | 'in_call';

export interface GuestServerEventMap {
  [GUEST_SERVER_EVENTS.GUEST_INVITED]: {
    entry_point: GuestInviteEntryPoint;
    /** SERVER-DERIVED from the actor's resolved side — never what the client claimed. */
    party: MeetingGuestSide;
    participation_role: MeetingParticipationRoleLabel;
    access_scope: GuestAccessScopeLabel;
    /**
     * Whether the address matched one of the client company's registered `party_domains`
     * — i.e. WHY the scope came out as it did. ⚠ A BOOLEAN, never the domain.
     */
    same_domain: boolean;
    /** The PRIMARY context's type (the D3 precedence winner). */
    context_type: MeetingContextTypeLabel;
    /** The INVITER's user id. */
    distinct_id: string;
  };
  [GUEST_SERVER_EVENTS.GUEST_REMOVED]: {
    party: MeetingGuestSide;
    access_scope: GuestAccessScopeLabel;
    /** Whether the guest had ever opened their link — did revocation actually take anything away? */
    had_joined: boolean;
    /** The REMOVER's user id. */
    distinct_id: string;
  };
  [GUEST_SERVER_EVENTS.GUEST_ADMITTED]: {
    party: MeetingGuestSide;
    /**
     * ⚠ BAL-132 — REQUIRED, AND IT IS WHAT MAKES `party` READABLE ON THIS EVENT. A
     * `link`-channel row's `party` is a PLACEHOLDER: the lobby writer stores `client`
     * because the column is NOT NULL, not because a side was resolved. Without this
     * discriminator every admit/deny in PostHog looks like a client-side guest, and the
     * placeholder silently pollutes the one dimension the event carries. Segment on it.
     */
    invite_channel: MeetingGuestInviteChannelLabel;
    /** The HOST's user id. */
    distinct_id: string;
  };
  [GUEST_SERVER_EVENTS.GUEST_DENIED]: {
    party: MeetingGuestSide;
    /** ⚠ BAL-132 — REQUIRED, for the reason on `guest_admitted` above. */
    invite_channel: MeetingGuestInviteChannelLabel;
    /** The HOST's user id. */
    distinct_id: string;
  };
  /**
   * BAL-132 — one successful guest Daily token mint.
   *
   * ⚠⚠ THIS IS A **MINT** EVENT, NOT A UNIQUE-VISITOR EVENT. It fires on EVERY successful
   * mint, which includes a rejoin after a network drop and a second device. **Count DISTINCT
   * `distinct_id`, never raw events.** Documented here rather than solved, exactly as
   * `guest_invite_opened` documents its scanner inflation: inventing a `first_joined_at`
   * column to make the count exact is not worth a migration for an analytics nicety.
   *
   * ⚠ AND IT FIRES ONLY ON A MINT — a `pending` guest polling the lobby emits NOTHING. That
   * absence is a deliberate property (Decision 2), asserted by a test: waiting is not joining,
   * and a poll every 5 seconds would otherwise flood the event stream.
   */
  [GUEST_SERVER_EVENTS.GUEST_JOINED]: {
    /**
     * ⚠⚠ **OPTIONAL — THE KEY IS OMITTED ENTIRELY ON A `link_share` JOIN.** Not `null`.
     *
     * `meeting_guests.party` is NOT NULL and CHECK-narrowed to `client | expert`, so the lobby
     * writer stores the PLACEHOLDER `client`: a bare meeting URL carries no sharer identity,
     * so there is no side to resolve. Emitting that placeholder would make a dashboard filtered
     * on `party = client` silently include every link-share joiner — a WRONG answer, not a
     * coarse one.
     *
     * ⚠ IT WAS TYPED `MeetingGuestSide | null` FIRST, AND THE DOCBLOCK CLAIMED THE PROPERTY WAS
     * "ABSENT RATHER THAN WRONG". **IT WAS NOT ABSENT.** `trackServer` spreads the properties
     * object verbatim into `client.capture({ properties: rest })`, so an explicit `null`
     * reached PostHog as `"party": null` — which satisfies a `party is set` filter, produces a
     * `null` bucket in every breakdown, and shows up as a real value in the property explorer.
     * The narrow claim F21 actually needed (a `party = client` filter must exclude link-share
     * joins) held either way; the stated one did not. An OMITTED key is the encoding that makes
     * the docblock true — `posthog-node` never sees a property that was never set.
     *
     * ⚠ SO A `party` ON THIS EVENT IS ALWAYS A RESOLVED SIDE, and `join_method` tells you when
     * to expect one at all. (The billing side never had this problem: `presencePartyForGuest`
     * maps the whole `link` channel to `observer` by a NON-OPTIONAL argument.)
     *
     * ⚠ WRITE IT WITH A CONDITIONAL SPREAD, NEVER `party: cond ? x : undefined`. This repo does
     * not enable `exactOptionalPropertyTypes`, so the second form COMPILES and reintroduces the
     * same defect one layer down — a present key holding `undefined`.
     */
    party?: MeetingGuestSide;
    /** SERVER-DERIVED from `meeting_guests.invite_channel`. See {@link GuestJoinMethod}. */
    join_method: GuestJoinMethod;
    /**
     * `true` when a host EXPLICITLY admitted them through the queue (`admission = 'admitted'`);
     * `false` for a trust-by-default invitee (`pre_admitted`). Together with `join_method`
     * this answers the product question: does the trust-by-default split behave as designed?
     */
    admitted: boolean;
    /** ⚠ `meeting_guests.id` — a guest has NO user id. See the module docblock. */
    distinct_id: string;
  };
  /**
   * BAL-436 — one credential rotation on the re-send path.
   *
   * ⚠ NO `invite_channel` PROPERTY, DELIBERATELY. The route accepts ONLY a `link`-channel row
   * (`resendGuestJoinLink` refuses anything else with `guest_link_not_resendable`), so the
   * property would be a constant — and a constant dimension is worse than no dimension: it
   * looks segmentable in the property explorer and segments nothing. Contrast
   * `guest_admitted` / `guest_denied`, where the channel genuinely varies and is the only
   * thing that makes their `party` readable.
   *
   * ⚠ NO `party` EITHER, FOR THE SAME REASON INVERTED: a `link` row's `party` is the lobby
   * writer's NOT-NULL PLACEHOLDER, never a resolved side, so emitting it would put every
   * re-send in the `client` bucket — a WRONG answer, not a coarse one.
   */
  [GUEST_SERVER_EVENTS.GUEST_LINK_RESENT]: {
    /** The HOST's user id. */
    distinct_id: string;
  };
  [GUEST_SERVER_EVENTS.GUEST_INVITE_OPENED]: {
    party: MeetingGuestSide;
    access_scope: GuestAccessScopeLabel;
    /** `true` on the first ever open — `access_count` was 0 before this request. */
    first_open: boolean;
    /** ⚠ `meeting_guests.id` — a guest has NO user id. See the module docblock. */
    distinct_id: string;
  };
  /**
   * BAL-439 (R12) — the guest recap rendered successfully.
   *
   * ⚠⚠ NO PII, NO COUNTERPARTY IDENTITY. No email, no company name, no counterparty name, no
   * expert id — every property here describes the GRANT or the READER'S OWN VIEW, never who is
   * on the other side. `summary_state` is `GuestRecapArtifactState` restated structurally
   * (`'processing' | 'ready' | 'absent' | 'failed'`) rather than imported — this package cannot
   * reach into `apps/web`, and TypeScript's structural typing makes the restatement a distinct
   * declaration, not a second source of truth to keep in sync by hand.
   */
  [GUEST_SERVER_EVENTS.GUEST_RECAP_VIEWED]: {
    /** The grant AS RECORDED on the guest's row — never re-derived. */
    access_scope: GuestAccessScopeLabel;
    /** `false` ⇒ an engagement-scope RETROSPECTIVE read of a meeting other than their own. */
    is_own_meeting: boolean;
    /** Which of the four states the summary card rendered in, for THIS reader. */
    summary_state: 'processing' | 'ready' | 'absent' | 'failed';
    /**
     * ⚠⚠ fix-round-1 / S6 (R12) — whole days, floored, from the meeting to this open. The main
     * question this event exists to answer ("how long after a call do guests open the recap")
     * is unanswerable without it. Computed at the PAGE from `view.header.occurredAtIso` —
     * never inside `resolveGuestSummary`, whose clock-free state machine is deliberate.
     */
    days_since_meeting: number;
    /** ⚠ `meeting_guests.id` — a guest has NO user id. See the module docblock. */
    distinct_id: string;
  };
}
