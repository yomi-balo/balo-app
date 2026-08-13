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
   *
   * ⚠ NO RATING FIELD (owner decision D5 / BAL-422). `expert_profiles` has NO `rating_avg` /
   * `rating_count`, `reviewsRepository.aggregateForExpert` has ZERO callers, and
   * `routes/experts/mapper.ts` hardcodes `rating: null`. The recap precedent is to OMIT it
   * entirely so BAL-422 slots in as one more line in the same stack with NO structural
   * change — never to fake a number.
   */
  bookAgainHref: string | null;
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

/** Exactly one, chosen by `selectCaseNudge`. `null` ⇒ the case is closed. */
export type CaseNudgeView =
  | { kind: 'upcoming'; meetingId: string; scheduledStartIso: string; live: boolean }
  | { kind: 'resolution_ask' }
  | { kind: 'resolution_ask_pending' }
  | { kind: 'nothing_booked' }
  | null;

// ── the root ─────────────────────────────────────────────────────────────────────────────

interface CaseSurfaceViewBase {
  engagementId: string;
  viewerUserId: string;
  header: CaseHeaderView;
  nudge: CaseNudgeView;
  consultations: CaseConsultationRowView[];
  conversation: CaseConversationView;
  actionItems: CaseActionItemsView;
  files: CaseFileRowView[];
  /** TRUE when the merged file list was BOUNDED — the card says so out loud (§6.4). */
  filesTruncated: boolean;
  party: CasePartyView;
  people: CasePersonView[];
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
    });
