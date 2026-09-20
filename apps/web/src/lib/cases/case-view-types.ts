import type { CaseConsultationStateLabel } from '@balo/shared/engagements';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/conversations/conversation-view-types';
import type { ActionItemNodeView } from '@/lib/engagement/action-items-view';

/**
 * BAL-421 — the case surface's single serializable contract. PLAIN TYPES ONLY: no values, no
 * functions, no constants.
 *
 * ⚠ CLIENT-SAFE BY CONSTRUCTION. Every import above is `import type`, so all are ERASED at
 * build and none drags `postgres` into a browser bundle (memory
 * `reference_balo_db_client_bundle_footgun`: a client component that VALUE-imports `@balo/db`
 * breaks `next build` because postgres cannot resolve `tls`). Do NOT add a runtime import, a
 * helper or a constant to this file.
 *
 * ── ⚠⚠ THE SECRET-LEAK BOUNDARY (P3) ─────────────────────────────────────────────────────
 * `meetingContextsRepository.listMeetingsForContext` returns FULL `Meeting` rows including
 * `daily_room_name` and `join_url` — LIVE CALL-JOIN CREDENTIALS. NO `@balo/db` row type is a
 * field of any shape here; every view is plain projected data, and the projection happens
 * SERVER-SIDE in `_lib/map-case-consultations.ts`. Corollaries, each load-bearing:
 *   · `joinUrl` / `dailyRoomName` are STRUCTURALLY ABSENT from `CaseConsultationRowView`;
 *   · `r2Key` is STRUCTURALLY ABSENT from `CaseFileRowView` — it is the exact object locator
 *     the presigner signs;
 *   · a relational `with:` is FORBIDDEN upstream (`with: { guests: true }` hydrates
 *     `token_hash` and every guest email; `with: { files: true }` hydrates `r2_key`);
 *   · ADR-1044 — counterparty NAMES cross the party boundary, EMAIL ADDRESSES NEVER. No
 *     email, no `mailto:`, no gravatar-style hash appears in any shape below.
 */

// ── consultations ────────────────────────────────────────────────────────────────────────

/** Re-exported so a consumer needs ONE import for the whole case contract. */
export type { CaseConsultationStateLabel };

export interface CaseConsultationRowView {
  /**
   * Used ONLY to build the recap href and the join CTA's subject. NEVER a room name, NEVER a
   * join url — see the module docblock.
   */
  meetingId: string;
  /** 1-based, from `deriveConsultationOrdinal`. `null` ⇒ cancelled, or not in the set. */
  ordinal: number | null;
  /**
   * ⚠ THE DERIVED LABEL, NOT `status` + `outcome`. Those two are consumed ONLY by
   * `deriveCaseConsultationState` server-side and are NEVER serialized. Do not "just add
   * status for the badge" — the client has no business re-deriving an outcome.
   */
  state: CaseConsultationStateLabel;
  scheduledStartIso: string;
  startedAtIso: string | null;
  /**
   * WALL-CLOCK minutes (`ended_at − started_at`), `null` when either stamp is missing.
   *
   * ⚠ NOT BILLED MINUTES, AND THERE IS NO MONEY IN THIS ROW AT ALL (owner decision,
   * 2026-07-31): no per-consultation charge, and no client-lens running total anywhere on
   * this surface. Money lives on the recap, the receipt and billing history. Duration stays
   * because it is about the WORK, not the bill.
   */
  durationMinutes: number | null;
  /**
   * `/meetings/{id}?from=case_surface`, or `null` when there is no recap destination (the
   * meeting has not ended). ⚠ NEVER a disabled CTA — an absent action beats a dead one.
   */
  recapHref: string | null;
  actionItemCount: number;
  fileCount: number;
  hasTranscript: boolean;
  /**
   * ⚠ HARD-`false` TODAY, AND THE INDICATOR DOES NOT RENDER. No recording exists anywhere on
   * the platform (BAL-126 / BAL-140 own capture). The field is present so the indicator is a
   * one-line change when it does, not so a component can pretend.
   */
  hasRecording: boolean;

  // ── Row actions — UPCOMING rows only, all FALSE / 0 on every other state. A component never
  // re-derives availability from `state` (see the HARD BLOCKER on `mapCaseConsultations`).
  // `scheduledMinutes` and `live` below are a SEPARATE group and do not follow this rule the
  // same way — see their own docs.

  /** CLIENT axis — structurally `false` on the expert lens. */
  canReschedule: boolean;
  /** EXPERT axis — structurally `false` on the client lens. */
  canProposeReschedule: boolean;
  /** Unlike the two move flags, NOT blocked by a live proposal ("one negotiation at a time"
   *  governs moving, not cancelling). */
  canCancel: boolean;
  /** PHASE 2 — hard-`false` in phase 1. The menu item never renders until this is real. */
  canInvite: boolean;
  /** PHASE 2 — hard-`0` in phase 1. */
  guestCount: number;
  /** `scheduled_end − scheduled_start`, minutes. NOT `durationMinutes` above, which is
   *  wall-clock and therefore `null` on every upcoming row — this is the duration that's always
   *  present here. */
  scheduledMinutes: number;
  /** Inside `CASE_JOIN_WINDOW_MINUTES` of this row's own start AND the row is upcoming — mirrors
   *  the nudge's `live` for the same meeting, per-row. Drives the "Starting soon" pill and the
   *  move-item visibility rule. `false`, never a stray `true`, on a past/terminal row: the join
   *  window itself has no closing bound, so the upcoming-state gate is what keeps this field
   *  honest once a row's `scheduledStart` is behind `now`. */
  live: boolean;
}

// ── files (the D4 merge) ─────────────────────────────────────────────────────────────────

/**
 * ⚠ DISCRIMINATED, NEVER WIDENED. `meeting_files` and `conversation_files` are two REAL
 * tables that differ structurally (party/source vs uploader; per-meeting vs per-thread), and
 * `packages/db/src/schema/meeting-files.ts` states plainly that "BAL-421 MERGES THE TWO ON
 * READ … neither table is a view of the other and neither is going away". The download action
 * branches on this to pick each side's OWN authorization helper.
 */
export type CaseFileOrigin = 'meeting' | 'conversation';

export interface CaseFileRowView {
  origin: CaseFileOrigin;
  /** `meeting_files.id` or `conversation_files.id` — unique only WITHIN its origin. */
  id: string;
  /** Present iff `origin === 'meeting'`; the download gate needs it as a WHERE term. */
  meetingId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAtIso: string;
  /** "You" for the viewer's own uploads, else the uploader's FIRST NAME. Never an email. */
  uploaderLabel: string;
  /** Human provenance: "Consultation 3" / "Conversation". */
  sourceLabel: string;
}

// ── conversation ─────────────────────────────────────────────────────────────────────────

export interface CaseConversationView {
  conversationId: string;
  /**
   * Composed from `engagementConversationIsWritable(status)` AT THE GATE. A closed case is
   * read-only — but still fully readable.
   */
  writable: boolean;
  counterpartyFirstName: string;
  counterpartyName: string;
  initialMessages: ConversationMessageView[];
  initialHasEarlier: boolean;
  initialFiles: ConversationFileView[];
  realtimeEnabled: boolean;
}

// ── action items ─────────────────────────────────────────────────────────────────────────

/**
 * Three groups, lens-relative. ⚠ `unassigned` IS WHERE `ai_extracted` ITEMS LAND — it is a
 * triage queue, and it renders even when the other two groups are empty.
 */
export interface CaseActionItemsView {
  yours: ActionItemNodeView[];
  theirs: ActionItemNodeView[];
  unassigned: ActionItemNodeView[];
  /** The other party's short label, for the "Theirs" group heading. */
  counterpartyLabel: string;
  doneCount: number;
  totalCount: number;
}

// ── parties ──────────────────────────────────────────────────────────────────────────────

export interface CasePartyView {
  /** The counterparty's name. NEVER an email address (ADR-1044). */
  name: string;
  headline: string | null;
  orgLabel: string | null;
  avatarUrl: string | null;
  initials: string;
  /**
   * `/experts/{username}` — the ONE forward action with a live destination, and only when
   * `expert_profiles.username` is non-null (the column is NULLABLE). `null` ⇒ no CTA at all.
   */
  bookAgainHref: string | null;
  /**
   * The counterparty expert's average rating (BAL-422), or `null`.
   *
   * ⚠⚠ CLIENT LENS ONLY, AND THAT IS AN INVARIANT, NOT A DEFAULT. On the expert lens the
   * counterparty is the client COMPANY, and nothing evaluative may appear there — the expert
   * is not scoring the client. `load-case.ts` populates these two fields on the `client`
   * branch and hardcodes `null` / `0` on the `expert` branch; a lens test asserts it.
   *
   * ⚠ `null` MEANS NO REVIEWS, NEVER 0.0. The card gates the whole rating line on THIS field
   * (never on `ratingCount`), because 0.0 is unrepresentable on a 1..5 scale.
   *
   * As the earlier docblock here promised, this landed as ONE MORE LINE in the same
   * avatar → name → headline → org stack, with no structural change and no faked number.
   */
  ratingAverage: number | null;
  /** ENGAGEMENTS REVIEWED, not review rows. Rendered WHENEVER `ratingAverage` is. */
  ratingCount: number;
}

export interface CasePersonView {
  name: string;
  /** "You" is resolved server-side; the client never compares ids to decide it. */
  isViewer: boolean;
}

// ── expert earnings (D2) ─────────────────────────────────────────────────────────────────

/**
 * ⚠⚠ A DISCRIMINATED UNION, MIRRORING `CaseExpertEarningsAggregate` 1:1 — the view mapper is
 * a pass-through. "NO DATA" AND "A$0.00" MUST NOT BE THE SAME VALUE: nothing writes
 * `credit_sessions.engagement_id` yet (BAL-400 will), so EVERY case today is `not_yet`, and a
 * flat `{state, number}` shape would render "A$0.00" — a MONEY CLAIM — for every expert on
 * the platform. Here the figure is STRUCTURALLY UNREPRESENTABLE until something finalizes.
 *
 * A `finalized` block CAN legitimately be `0`. That is a REAL zero, which is exactly why the
 * three states must stay distinct in the UI.
 */
export type CaseEarningsView =
  | { state: 'not_yet'; earningsAudMinor: null; finalizedCount: 0; pendingCount: 0 }
  | { state: 'pending'; earningsAudMinor: null; finalizedCount: 0; pendingCount: number }
  | { state: 'finalized'; earningsAudMinor: number; finalizedCount: number; pendingCount: number };

// ── header + nudge ───────────────────────────────────────────────────────────────────────

export type CaseCloseReasonLabel = 'resolved' | 'auto_inactive';

export interface CaseHeaderView {
  title: string;
  /** Sanitised HTML from `case_engagements.description`. Clamped client-side. */
  descriptionHtml: string;
  openedAtIso: string;
  heldConsultationCount: number;
  consultationCount: number;
  isOpen: boolean;
  closeReason: CaseCloseReasonLabel | null;
  closedAtIso: string | null;
  /** The other party's org: the expert's agency (client lens) or the company (expert lens). */
  counterpartyOrgLabel: string;
  /** The neutral note a CLOSED case renders. `null` while open. */
  closedNote: string | null;
}

/**
 * Exactly one, chosen by `selectCaseNudge`. `null` ⇒ the case is closed.
 *
 * ⚠⚠ BAL-567 — `actorLabel` IS REQUIRED ON ALL FOUR ATTRIBUTED ARMS, NOT OPTIONAL. Those four
 * arms exist because SOMEBODY did something; an arm that could render without naming them is
 * exactly how "You've asked if this is sorted" came to be shown to every expert-side viewer,
 * including agency colleagues who did nothing. Requiring the field means the arm cannot be
 * constructed without it. Resolved server-side by `resolveActorLabel`
 * (`@/lib/cases/actor-attribution`) — NAME COLUMNS ONLY, never an email (ADR-1044).
 *
 * ⚠ `nothing_booked` AND `upcoming` CARRY NO `actorLabel`, deliberately: nobody acted. Their
 * copy is PROSPECTIVE and names the counterparty PARTY (`counterpartyLabel`), which is a
 * different register — see `counterpartyPartyLabel`'s docblock.
 */
export type CaseNudgeView =
  | {
      kind: 'upcoming';
      meetingId: string;
      scheduledStartIso: string;
      live: boolean;
      /**
       * BAL-409 — the meeting's current length, minutes. An ADDITIVE field on this WEB WIRE
       * PROJECTION only — `@balo/shared/engagements`'s `CaseNudge` discriminated union is
       * UNCHANGED (a client-initiated reschedule auto-approves; it produces no new state for
       * that union to represent). The reschedule dialog needs the current duration so it can
       * pin the picker (`fixedDurationMinutes`) and so the Server Action can compute
       * `scheduledEnd` server-side without a second read.
       */
      durationMinutes: number;
      /**
       * BAL-567 — `memberCallPath(meetingId)`, the AUTHENTICATED member call route
       * (`/meetings/{id}/call`). ADDITIVE on this WEB WIRE PROJECTION only, the same posture as
       * `durationMinutes` above: `@balo/shared/engagements`'s `CaseNudge` union is unchanged.
       *
       * ⚠⚠ BUILT SERVER-SIDE AND NAVIGATED TO, NEVER RENDERED AS AN `href`. `JoinMeetingButton`
       * is a `<button>` + `globalThis.location.assign` precisely so the meeting id never becomes
       * a DOM attribute PostHog autocapture or Sentry Session Replay can lift. Do not "restore"
       * a link — `invariants/join-link-never-writes.test.ts` scans this route for exactly that.
       *
       * ⚠ NOT A CREDENTIAL AND NOT A ROOM. It is a path built from the `meetingId` this arm
       * already carries; `meetings.join_url` / `daily_room_name` stay structurally absent from
       * every shape in this file (see the module docblock).
       */
      joinPath: string;
    }
  /**
   * CLIENT lens — the expert asked to move it; only the client can answer. `proposedAtIso` and
   * `options` live on `CaseRescheduleProposalView` below, not here — this nudge stays purely
   * informational; the accept/decline/withdraw affordances live on `RescheduleProposalCard`.
   */
  | {
      kind: 'reschedule_proposal';
      proposalId: string;
      meetingId: string;
      optionCount: number;
      originalScheduledStartIso: string;
      expiresAtIso: string;
      /** BAL-567 — see {@link CaseNudgeView}'s attribution note. */
      actorLabel: string;
    }
  /** EXPERT lens — their own outstanding proposal. See the sibling arm's note above —
   *  `proposedAtIso` / `options` live on `CaseRescheduleProposalView` for the identical reason. */
  | {
      kind: 'reschedule_proposal_pending';
      proposalId: string;
      meetingId: string;
      optionCount: number;
      expiresAtIso: string;
      /** BAL-567 — see {@link CaseNudgeView}'s attribution note. */
      actorLabel: string;
    }
  | { kind: 'resolution_ask'; actorLabel: string }
  | { kind: 'resolution_ask_pending'; actorLabel: string }
  | { kind: 'nothing_booked' }
  | null;

// ── Reschedule proposal cards ────────────────────────────────────────────────────────────

/**
 * ONE live reschedule proposal, decoupled from `CaseNudgeView` so `RescheduleProposalCard` can
 * be hosted per-row rather than only above the list under the nudge's own meeting.
 * `case-surface.tsx` renders one card per entry in `CaseSurfaceViewBase.rescheduleProposals`,
 * never derived from `nudge.kind`.
 */
export interface CaseRescheduleProposalView {
  proposalId: string;
  meetingId: string;
  /** 1-based, or `null` (structurally unreachable here, kept nullable as the honest type). The
   *  card's only subject-identifying field — without it, two live proposals render as visually
   *  and programmatically identical cards, so accepting one risks moving the wrong meeting. */
  ordinal: number | null;
  optionCount: number;
  originalScheduledStartIso: string;
  expiresAtIso: string;
  /** `null` only when the loader's detail read raced the proposal resolving out from under it
   *  — structurally unreachable through the normal path, kept nullable as the honest type. */
  proposedAtIso: string | null;
  options: readonly { optionId: string; scheduledStartIso: string }[];
  /** The meeting's booked length, minutes — a reschedule MOVES a booking, it never resizes it,
   *  so every option renders it alongside the time (never a bare start). */
  durationMinutes: number;
  /** Attribution — resolved server-side, name columns only, never an email address. */
  actorLabel: string;
}

// ── the root ─────────────────────────────────────────────────────────────────────────────

interface CaseSurfaceViewBase {
  engagementId: string;
  /** BAL-400 — exposed so the client-lens party card can mount `CaseSlotQuickPick` (entry
   *  point 3, D4a) without a second read; already resolved on `CaseAccess`. */
  expertProfileId: string;
  viewerUserId: string;
  header: CaseHeaderView;
  nudge: CaseNudgeView;
  consultations: CaseConsultationRowView[];
  /** Every upcoming meeting's live reschedule proposal, independent of `nudge` — a proposal on
   *  a meeting that isn't `nudge`'s own still appears here. `[]` in the overwhelming majority
   *  of cases. */
  rescheduleProposals: CaseRescheduleProposalView[];
  conversation: CaseConversationView;
  actionItems: CaseActionItemsView;
  files: CaseFileRowView[];
  /** TRUE when the merged file list was BOUNDED — the card says so out loud (§6.4). */
  filesTruncated: boolean;
  party: CasePartyView;
  people: CasePersonView[];
  /**
   * BAL-410 — the counterparty's PARTY label, lens-relative: the expert's agency (or their own
   * name when independent) on the client lens, the client company on the expert lens.
   *
   * ⚠⚠ NEVER A PERSON ON THE CLIENT LENS, and that is the whole reason this field exists
   * separately from `conversation.counterpartyFirstName`. CLAUDE.md's attribution-by-tense rule:
   * PROSPECTIVE copy ("… will see the slot open up again") names the PARTY, because rights sit on
   * company/agency membership (ADR-1029) and a client who booked through an agency may never have
   * been told the individual expert's name. `counterpartyFirstName` is the RETROSPECTIVE /
   * person-addressed register (the conversation composer) and is not interchangeable with this.
   *
   * Resolved server-side in `load-case.ts` from `expertPartyDisplayName` (`@balo/shared/parties`)
   * — the SAME single definition `publish-booking-cancelled.ts` uses for the email copy, so the
   * two surfaces cannot drift.
   */
  counterpartyPartyLabel: string;
}

/**
 * ⚠⚠ THE LENS IS A DISCRIMINANT, NOT A FLAG — AND IT IS THE FEE-CONCEALMENT INVARIANT MADE
 * STRUCTURAL. The client arm has NO `earnings` FIELD AT ALL, so a client-lens view object
 * cannot HOLD an expert's earnings figure and no component can leak one by mistake. The
 * expert arm has no `canClose`, because only a client may close a case (BAL-417) — the expert
 * may only ASK. And `margin` / `baloFeeBps` exist in NEITHER arm, on purpose: the client sees
 * the all-in charge only, the expert sees own earnings only, and the Balo margin appears to
 * nobody.
 *
 * ⚠ ALL THREE ARE PINNED BY `case-view-types.test.ts`, which asserts them TWICE OVER: with
 * compile-time `Exclude<keyof …>` witnesses that fail `tsc` (this repo has no `.test-d.ts`
 * tooling — vitest `typecheck` is not configured — so the witnesses are ordinary exported
 * types the gate's `pnpm typecheck` still checks), AND with runtime `in`-operator assertions
 * over CONSTRUCTED objects, because a type alone cannot stop `load-case.ts` from spreading an
 * extra key past a structurally-typed assignment.
 */
export type CaseSurfaceView =
  | (CaseSurfaceViewBase & { lens: 'client'; canClose: boolean })
  | (CaseSurfaceViewBase & {
      lens: 'expert';
      earnings: CaseEarningsView;
      canRequestResolution: boolean;
      /**
       * Fix round 1 item 18 (security LOW) — the SAME `manage_engagement` holder set as the
       * per-row `canProposeReschedule` (`CaseConsultationRowView`), without its "no live
       * proposal already outstanding" condition. That per-row flag is structurally `false`
       * exactly when Withdraw is relevant (a live proposal exists), so `RescheduleProposalCard`
       * needs this SEPARATE flag to gate Withdraw on the actual holder set rather than
       * `lens === 'expert'` alone — which also admits an agency member with role `expert`,
       * deliberately and permanently NOT a `manage_engagement` holder (ADR-1046 §7). A render
       * hint only; the withdraw action re-checks independently.
       */
      canManageReschedule: boolean;
    });
