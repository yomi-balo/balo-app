import type {
  PortfolioRequestRow,
  PortfolioInvitationRow,
  PortfolioProjectEngagementView,
  ProposalStatus,
} from '@balo/db';
import { relationshipIsOpened } from '@balo/shared/project-requests';
import {
  DIRECT_CHOICE_LABEL,
  directExpertOwesChoice,
} from '@/lib/project-request/direct-request-choice';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import type { RelationshipStatus } from '@/lib/project-request/conversation-view-types';
import { QUIET_THRESHOLD_DAYS } from '@/lib/project-request/request-detail-view';
import type { PortfolioLens } from './resolve-portfolio-lens';

/**
 * portfolio-row — the PURE, client-safe view-model layer for the A7 tri-lens
 * portfolio dashboard (BAL-274). Holds the serialisable DTO types, the
 * request-level recency fold (`requestRecencyAt`), the stage-chip mapping
 * (`stageChipFor` / `stageDistribution`), and the needs-you + nudge rule table
 * (`needsYouFor` / `nudgeFor`). NO runtime `@balo/db` import — every `@balo/db`
 * reference here is `import type` (erased at compile) so a `"use client"`
 * component can import the DTO types without dragging postgres-js into the
 * browser bundle. The `server-only` loaders live in `portfolio-view.ts`.
 *
 * The needs-you / nudge logic is the design's rule table, composed from the same
 * facts the detail-page derivers key on (`QUIET_THRESHOLD_DAYS`, relationship
 * status, the per-relationship last-activity fold, thread unread/await signals).
 * It is NOT re-derived per-thread — `threadNudgeFor` keys on a single thread;
 * A7 keys on the most-actionable request-level signal these helpers compute.
 */

const DAY_MS = 1000 * 60 * 60 * 24;

/** Design `STAGE` keys — the visual pipeline stage chip. */
export type StageKey =
  | 'requested'
  // Admin asked for an exploratory call before inviting anyone — the client books next.
  // Its own stage so the list never claims experts were invited when none were.
  | 'exploratory'
  | 'invited'
  | 'eoi'
  | 'prop_req'
  | 'prop_in'
  | 'accepted'
  | 'kicked'
  // BAL-540 — the terminal `closed`. Its own stage rather than folded into an
  // existing one so the portfolio can group/exclude it distinctly (Phase 7).
  | 'closed';

/** The portfolio filter tiles (participant lenses). */
export type PortfolioFilter = 'all' | 'needs' | 'in_progress' | 'kicked';

/**
 * Which expert-side action a needs-you row is asking for. Set by the same branch that sets
 * `needsYou`, so `needsYou === (moveKind !== null)` on every expert row; consumers map it to a
 * card and never parse `stage` or `nudgeLabel`.
 */
export type ExpertMoveKind =
  | 'invitation'
  // A direct request's chosen expert who has not yet acted on it (`directExpertOwesChoice`).
  | 'direct_request'
  | 'eoi_propose_times'
  | 'eoi_reply_owed'
  | 'proposal_requested'
  | 'changes_requested'
  | 'delivery_changes';

/**
 * Which client-side action a needs-you row is asking for. Set by the same branch that sets
 * `needsYou`, so `needsYou === (clientMoveKind !== null)` on every client row; consumers map it
 * to a card and never parse `stage` or `nudgeLabel`.
 */
export type ClientMoveKind =
  | 'exploratory_call'
  | 'eoi_reply'
  | 'proposal_review'
  | 'kickoff_billing'
  | 'kickoff_payment'
  | 'completion';

/** One message thread a row can open: a request relationship or a delivery engagement. */
export interface PortfolioThreadRef {
  contextType: 'relationship' | 'engagement';
  contextId: string;
  expertProfileId: string | null;
}

/** A serialisable portfolio row — what crosses the RSC boundary to the client. */
export interface PortfolioRowView {
  id: string;
  /** `/projects/{id}` — null when there is no navigable target (retainer seam). */
  href: string | null;
  title: string;
  companyName: string | null;
  stage: StageKey;
  stageLabel: string;
  needsYou: boolean;
  nudgeLabel: string;
  /** "3 of 5 milestones" for engagement rows; unset for request rows / zero-milestone. */
  progressLabel?: string | null;
  unread: boolean;
  /** "2 days ago" — relative label of the recency timestamp. */
  updatedRelative: string;
  /** ISO recency timestamp (sort key already applied server-side). */
  recencyAtIso: string;
  /** Freshest inbound signal preview, or null. */
  signal?: { from: string; messagePreview: string; relationshipId?: string } | null;
  kind: 'request' | 'engagement';
  /** Engagement rows only; unset on request rows. Consumers never parse `nudgeLabel`. */
  deliveryState?: EngagementDeliveryState | null;
  /** The expert-side action this row asks for; null when `needsYou` is false (client rows: null). */
  moveKind?: ExpertMoveKind | null;
  /** The client-side action this row asks for; null when `needsYou` is false (expert rows: unset). */
  clientMoveKind?: ClientMoveKind | null;
  /** Open message threads this row can open; empty when the row has none. */
  threadRefs?: PortfolioThreadRef[];
  /** The delivering expert's profile id on a client engagement row; unset elsewhere. */
  expertProfileId?: string | null;
  /** Completion review facts on a client `pending_acceptance` engagement row; null otherwise. */
  completion?: {
    milestonesDone: number;
    milestonesTotal: number;
    completionRequestedAtIso: string;
    autoAcceptAtIso: string;
  } | null;
  /** The expert's relationship id on an expert request row; unset elsewhere. */
  relationshipId?: string | null;
  /** The client's change request on a `delivery_changes` engagement row; null otherwise. */
  delivery?: { changeRequestNote: string; milestonesDone: number; milestonesTotal: number } | null;
}

/** Participant-lens DTO (client / expert). Fully serialisable (ISO + labels). */
export interface PortfolioDTO {
  lens: 'client' | 'expert';
  allowedLenses: PortfolioLens[];
  /** The LIVE portfolio (closed requests excluded), ranked needs-you-first then recency desc. */
  rows: PortfolioRowView[];
  tiles: { needs: number; inProgress: number; kicked: number; total: number };
  isEmpty: boolean;
  /**
   * BAL-540 — closed requests, partitioned out of `rows` (never counted in `tiles`/`isEmpty` —
   * that keeps every pre-existing consumer's semantics unchanged). Rendered as a collapsed
   * "Closed" group below the main list; the CLAUDE.md empty-state exception for purely
   * retrospective data applies — an empty array renders NOTHING, never an invitation.
   */
  closedRows: PortfolioRowView[];
}

/** One admin triage hero card (`status === 'requested'`). */
export interface AdminTriageCard {
  id: string;
  href: string;
  title: string;
  companyName: string | null;
  raisedRelative: string;
  /** True when raised > 24h ago (the design's `>24h` destructive pill). */
  overdue: boolean;
}

/** One admin pipeline kanban card. */
export interface AdminKanbanCard {
  id: string;
  href: string;
  title: string;
  companyName: string | null;
  updatedRelative: string;
  /** Stall chip copy ("No EOIs · 3d") or null. */
  stalledLabel: string | null;
  /**
   * BAL-541 — ADMIN DTO ONLY. `null` = unassigned (design ref's dashed placeholder,
   * `request-close.jsx:1291-1298`) and always `null` on delivery (engagement) cards —
   * engagements have no Balo owner (out of scope). Initials are derived in the component.
   * ⚠ THERE IS NO EQUIVALENT FIELD ON `PortfolioRowView` and there must not be (D9).
   */
  baloOwner: { userId: string; name: string } | null;
}

/** One admin kanban column, grouped by stage. */
export interface AdminKanbanColumn {
  stage: StageKey;
  label: string;
  items: AdminKanbanCard[];
}

/** Admin-lens DTO. */
export interface AdminPortfolioDTO {
  lens: 'admin';
  allowedLenses: PortfolioLens[];
  triage: AdminTriageCard[];
  kanban: AdminKanbanColumn[];
  tiles: { untriaged: number; stalled: number; pipeline: number; gate: number };
  isEmpty: boolean;
}

// ── Stage chip mapping ─────────────────────────────────────────────

/** Stage chip label per design `STAGE` key. */
const STAGE_LABELS: Record<StageKey, string> = {
  requested: 'Requested',
  exploratory: 'Exploratory call',
  invited: 'Experts invited',
  eoi: 'In conversation',
  prop_req: 'Proposal req.',
  prop_in: 'Proposals in',
  accepted: 'Accepted',
  kicked: 'Kicked off',
  closed: 'Closed',
};

/** Request status → design stage key (the table in the plan §Stage chip mapping). */
const REQUEST_STATUS_TO_STAGE: Record<ProjectRequestStatus, StageKey> = {
  draft: 'requested',
  requested: 'requested',
  exploratory_meeting_requested: 'exploratory',
  experts_invited: 'invited',
  eoi_submitted: 'eoi',
  proposal_requested: 'prop_req',
  proposal_submitted: 'prop_in',
  accepted: 'accepted',
  kickoff_approved: 'kicked',
  closed: 'closed',
};

/** Relationship status → design stage key (expert lens, per-relationship). */
const RELATIONSHIP_STATUS_TO_STAGE: Record<RelationshipStatus, StageKey> = {
  invited: 'invited',
  eoi_submitted: 'eoi',
  proposal_requested: 'prop_req',
  proposal_submitted: 'prop_in',
  accepted: 'accepted',
  declined: 'invited',
};

/** Stage chip {key,label} for a request status. */
export function stageChipFor(status: ProjectRequestStatus): { key: StageKey; label: string } {
  const key = REQUEST_STATUS_TO_STAGE[status];
  return { key, label: STAGE_LABELS[key] };
}

/** Stage chip {key,label} for a relationship status (expert lens). */
export function stageChipForRelationship(status: RelationshipStatus): {
  key: StageKey;
  label: string;
} {
  const key = RELATIONSHIP_STATUS_TO_STAGE[status];
  return { key, label: STAGE_LABELS[key] };
}

/** Stage label for a stage key (kanban column headers). */
export function stageLabelFor(stage: StageKey): string {
  return STAGE_LABELS[stage];
}

/**
 * Count of rows per stage key — drives the PostHog-derivable stage distribution.
 * Returns a complete record (every stage key present, 0 when empty).
 */
export function stageDistribution(
  rows: ReadonlyArray<{ stage: StageKey }>
): Record<StageKey, number> {
  const dist: Record<StageKey, number> = {
    requested: 0,
    exploratory: 0,
    invited: 0,
    eoi: 0,
    prop_req: 0,
    prop_in: 0,
    accepted: 0,
    kicked: 0,
    closed: 0,
  };
  for (const row of rows) dist[row.stage] += 1;
  return dist;
}

// ── Recency fold ───────────────────────────────────────────────────

/** Newest of a seed date and zero or more further dates. */
export function maxDate(seed: Date, more: ReadonlyArray<Date>): Date {
  return more.reduce((max, d) => (d.getTime() > max.getTime() ? d : max), seed);
}

/**
 * Per-relationship last-activity fold (generalises the detail page's
 * `lastActivityAt`): max of the relationship's `invitedAt`, its row `updatedAt`,
 * its newest live EOI `submittedAt`, and its newest live message `createdAt`.
 */
function relationshipLastActivityAt(
  relationship: PortfolioRequestRow['relationships'][number]
): Date {
  const candidates: Date[] = [relationship.updatedAt];
  const [latestEoi] = relationship.expressionsOfInterest;
  if (latestEoi !== undefined) candidates.push(latestEoi.submittedAt);
  const [latestMessage] = relationship.conversationMessages;
  if (latestMessage !== undefined) candidates.push(latestMessage.createdAt);
  return maxDate(relationship.invitedAt, candidates);
}

/**
 * Request-level last-activity (THE canonical portfolio ORDER BY key): max over
 * the request's own `updatedAt` and every relationship's per-relationship fold.
 * No relationships → falls back to `updatedAt` then `createdAt`. Pure.
 */
export function requestRecencyAt(row: PortfolioRequestRow): Date {
  const relationshipActivity = row.relationships.map(relationshipLastActivityAt);
  // `updatedAt` seeds the fold (always present); `createdAt` is implicitly
  // covered because `updatedAt >= createdAt` for every row.
  return maxDate(row.updatedAt, relationshipActivity);
}

/**
 * {@link requestRecencyAt} as the CLIENT may see it: folds only tracks that have opened
 * (`relationshipIsOpened`), so an unopened expert's row never moves the client's "updated" time
 * or sort order. The request's own `updatedAt` still moves on the first invite (the status
 * rollup to `experts_invited`): that is the request stage, which the client sees by design.
 */
export function clientRequestRecencyAt(row: PortfolioRequestRow): Date {
  return requestRecencyAt({
    ...row,
    relationships: row.relationships.filter(relationshipIsOpened),
  });
}

/** Whole days between two instants (floored, never negative-clamped here). */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

// ── Needs-you signal facts (loader-supplied, request-level) ─────────

/**
 * The request-level conversation signal the needs-you rules key on — folded by
 * the loader from the batched thread summaries (NOT re-derived here). All facts
 * are request-level aggregates over the request's open threads.
 */
export interface RequestThreadSignal {
  /** Any open thread has inbound activity newer than the viewer's read mark. */
  anyUnread: boolean;
  /**
   * The other party is awaiting a reply: latest message in some thread is NOT
   * from the viewer (covers the "activated tab cleared the dot but still owes a
   * reply" case the detail nudge handles).
   */
  awaitingViewerReply: boolean;
  /** Freshest inbound preview ({from, messagePreview}) or null. */
  freshestSignal: { from: string; messagePreview: string; relationshipId?: string } | null;
  /** The viewer has written at least one live message in some open thread. */
  viewerHasSentMessage: boolean;
}

const EMPTY_SIGNAL: RequestThreadSignal = {
  anyUnread: false,
  awaitingViewerReply: false,
  freshestSignal: null,
  viewerHasSentMessage: false,
};

/**
 * A submitted proposal awaits the client's review unless the client already asked for changes —
 * then the move is the expert's. The one definition of "awaiting client review".
 */
export function proposalAwaitsClientReview(
  relationshipStatus: string,
  currentProposalStatus: ProposalStatus | null
): boolean {
  return (
    relationshipStatus === 'proposal_submitted' && currentProposalStatus !== 'changes_requested'
  );
}

/** Count of relationships awaiting the client's proposal review — "Review N proposals". */
function proposalSubmittedCount(row: PortfolioRequestRow): number {
  return row.relationships.filter((r) => {
    const [current] = r.proposals;
    return proposalAwaitsClientReview(r.status, current?.status ?? null);
  }).length;
}

/** The freshest single expert first name for "Reply to {expert}". */
function awaitingExpertName(signal: RequestThreadSignal): string {
  return signal.freshestSignal?.from ?? 'the expert';
}

// ── Client lens needs-you + nudge ──────────────────────────────────

interface NeedsYouResult {
  needsYou: boolean;
  nudgeLabel: string;
}

/** Client-lens result: the needs-you decision plus the typed reason (null when not needed). */
export type ClientNeedsYouResult = NeedsYouResult & { clientMoveKind: ClientMoveKind | null };

/** Expert-lens result: the needs-you decision plus the typed reason (null when not needed). */
export type ExpertNeedsYouResult = NeedsYouResult & { moveKind: ExpertMoveKind | null };

function clientNeedsYou(
  row: PortfolioRequestRow,
  signal: RequestThreadSignal
): ClientNeedsYouResult {
  switch (row.status) {
    case 'draft':
    case 'requested':
      return { needsYou: false, nudgeLabel: 'Waiting on Balo', clientMoveKind: null };
    case 'exploratory_meeting_requested':
      return {
        needsYou: true,
        nudgeLabel: 'Book exploratory call',
        clientMoveKind: 'exploratory_call',
      };
    case 'experts_invited':
      return { needsYou: false, nudgeLabel: 'Waiting on experts', clientMoveKind: null };
    case 'eoi_submitted': {
      const needsYou = signal.anyUnread || signal.awaitingViewerReply;
      return {
        needsYou,
        nudgeLabel: needsYou ? `Reply to ${awaitingExpertName(signal)}` : 'In conversation',
        clientMoveKind: needsYou ? 'eoi_reply' : null,
      };
    }
    case 'proposal_requested':
      return { needsYou: false, nudgeLabel: 'Proposal in progress', clientMoveKind: null };
    case 'proposal_submitted': {
      const count = proposalSubmittedCount(row);
      if (count === 0) {
        return { needsYou: false, nudgeLabel: 'Waiting on expert', clientMoveKind: null };
      }
      const label = count > 1 ? `Review ${count} proposals` : 'Review proposal';
      return { needsYou: true, nudgeLabel: label, clientMoveKind: 'proposal_review' };
    }
    case 'accepted': {
      // Billing, then (once Balo has raised it) the upfront invoice, are the client's.
      if (row.clientBillingConfirmedAt === null) {
        return { needsYou: true, nudgeLabel: 'Confirm billing', clientMoveKind: 'kickoff_billing' };
      }
      if (row.upfrontInvoiceRaisedAt !== null) {
        return { needsYou: true, nudgeLabel: 'Pay invoice', clientMoveKind: 'kickoff_payment' };
      }
      return { needsYou: false, nudgeLabel: 'Awaiting kickoff', clientMoveKind: null };
    }
    case 'kickoff_approved':
      return { needsYou: false, nudgeLabel: 'Live project', clientMoveKind: null };
    case 'closed':
      return { needsYou: false, nudgeLabel: 'Closed', clientMoveKind: null };
    default:
      return assertNeverStatus(row.status);
  }
}

// ── Expert lens needs-you + nudge (per-relationship) ───────────────

function expertNeedsYou(
  invitation: PortfolioInvitationRow,
  signal: RequestThreadSignal
): ExpertNeedsYouResult {
  // BAL-540 — a closed request needs nothing from anybody, on ANY relationship status,
  // BEFORE the accepted/kickoff_approved branch below (which would otherwise read a closed
  // request's accepted relationship as still owing the kickoff gate).
  if (invitation.requestStatus === 'closed') {
    return { needsYou: false, nudgeLabel: 'Closed', moveKind: null };
  }

  // Request-level decision: the surviving thread waits on kickoff (the checklist runs
  // between the client and Balo); a non-accepted relationship on a decided request is lost.
  if (invitation.requestStatus === 'accepted' || invitation.requestStatus === 'kickoff_approved') {
    if (invitation.relationshipStatus === 'accepted') {
      return invitation.requestStatus === 'kickoff_approved'
        ? { needsYou: false, nudgeLabel: 'Live project', moveKind: null }
        : { needsYou: false, nudgeLabel: 'Awaiting kickoff', moveKind: null };
    }
    return { needsYou: false, nudgeLabel: 'Not selected', moveKind: null };
  }

  switch (invitation.relationshipStatus) {
    case 'invited':
      return { needsYou: true, nudgeLabel: 'Submit your EOI', moveKind: 'invitation' };
    case 'eoi_submitted': {
      const owesChoice = directExpertOwesChoice({
        onDirectLeg: invitation.onDirectLeg,
        relationshipStatus: invitation.relationshipStatus,
        availabilityShared: invitation.availabilitySharedAt !== null,
        sentMessage: signal.viewerHasSentMessage,
      });
      if (owesChoice) {
        return { needsYou: true, nudgeLabel: DIRECT_CHOICE_LABEL, moveKind: 'direct_request' };
      }
      const needsReply = signal.anyUnread || signal.awaitingViewerReply;
      return {
        needsYou: true,
        nudgeLabel: needsReply ? 'Reply to client' : 'Propose times',
        moveKind: needsReply ? 'eoi_reply_owed' : 'eoi_propose_times',
      };
    }
    case 'proposal_requested':
      return {
        needsYou: true,
        nudgeLabel: 'Build your proposal',
        moveKind: 'proposal_requested',
      };
    case 'proposal_submitted':
      if (invitation.currentProposalStatus === 'changes_requested') {
        return {
          needsYou: true,
          nudgeLabel: 'Revise your proposal',
          moveKind: 'changes_requested',
        };
      }
      return { needsYou: false, nudgeLabel: 'Waiting on client', moveKind: null };
    case 'accepted':
      return { needsYou: false, nudgeLabel: 'Awaiting kickoff', moveKind: null };
    case 'declined':
    default:
      return { needsYou: false, nudgeLabel: 'Not selected', moveKind: null };
  }
}

// ── Admin lens needs-you + nudge ───────────────────────────────────

/**
 * An accepted request always has Balo in the loop: chasing billing, raising the upfront
 * invoice (or approving when nothing is due upfront), then confirming payment.
 */
function adminKickoffLabel(row: PortfolioRequestRow): string {
  if (row.clientBillingConfirmedAt === null) return 'Kickoff gate';
  if (row.upfrontInvoiceRaisedAt === null) return 'Ready for kickoff';
  return 'Awaiting payment';
}

function adminNeedsYou(row: PortfolioRequestRow, now: Date): NeedsYouResult {
  switch (row.status) {
    case 'draft':
    case 'requested':
      return { needsYou: true, nudgeLabel: 'Triage' };
    case 'exploratory_meeting_requested':
      return { needsYou: false, nudgeLabel: 'Awaiting client booking' };
    case 'experts_invited': {
      const stalled = adminStallDays(row, now);
      if (stalled !== null) {
        return { needsYou: true, nudgeLabel: `No EOIs · ${stalled}d` };
      }
      return { needsYou: false, nudgeLabel: 'Experts invited' };
    }
    case 'accepted':
      return { needsYou: true, nudgeLabel: adminKickoffLabel(row) };
    case 'kickoff_approved':
      return { needsYou: false, nudgeLabel: 'Live project' };
    case 'eoi_submitted':
      return { needsYou: false, nudgeLabel: 'In conversation' };
    case 'proposal_requested':
      return { needsYou: false, nudgeLabel: 'Proposal requested' };
    case 'proposal_submitted':
      return { needsYou: false, nudgeLabel: 'Proposals in' };
    default:
      return { needsYou: false, nudgeLabel: stageChipFor(row.status).label };
  }
}

/**
 * Stall days for an admin `experts_invited` request: whole days since the newest
 * relationship activity (reusing the per-relationship fold + `QUIET_THRESHOLD_DAYS`).
 * Returns the day-count when stalled, else null. A request with no relationships
 * is stalled if it has been quiet at the request level for the threshold.
 */
export function adminStallDays(row: PortfolioRequestRow, now: Date = new Date()): number | null {
  const newestActivity = requestRecencyAt(row);
  const quietDays = daysBetween(newestActivity, now);
  return quietDays >= QUIET_THRESHOLD_DAYS ? quietDays : null;
}

// ── Public needs-you resolution (used by the loaders) ──────────────

/** Client / admin request-row needs-you + nudge resolution. */
export function needsYouFor(
  lens: 'client' | 'admin',
  row: PortfolioRequestRow,
  signal: RequestThreadSignal = EMPTY_SIGNAL,
  now: Date = new Date()
): ClientNeedsYouResult {
  return lens === 'client'
    ? clientNeedsYou(row, signal)
    : { ...adminNeedsYou(row, now), clientMoveKind: null };
}

/** Expert invitation-row needs-you + nudge resolution (per-relationship). */
export function needsYouForExpert(
  invitation: PortfolioInvitationRow,
  signal: RequestThreadSignal = EMPTY_SIGNAL
): ExpertNeedsYouResult {
  return expertNeedsYou(invitation, signal);
}

// ── Engagement-row deriver (post-kickoff delivery, D6) ─────────────

/**
 * The delivery state a track groups on. `active` splits on the change note, because the raw
 * status cannot tell "Changes requested" (waiting) from "In delivery" (in progress).
 */
export type EngagementDeliveryState =
  | 'in_delivery'
  | 'changes_requested'
  | 'pending_acceptance'
  | 'completed'
  | 'cancelled';

/** The engagement status the deriver switches on (schema-derived; import type only). */
type EngagementRowStatus = PortfolioProjectEngagementView['status'];

/**
 * The plain, serialisable facts a loader assembles for ONE engagement row — the
 * deriver is DB-free so it is exhaustively unit-testable. `counterpartName` is the
 * OTHER party (client lens → the expert party display name; expert lens → the
 * client company). `autoAcceptLabel` is a preformatted date, non-null only for
 * `pending_acceptance` (the loader owns TZ-pinned formatting).
 */
export interface EngagementRowInput {
  engagementId: string;
  status: EngagementRowStatus;
  lens: 'client' | 'expert';
  hasChangeRequest: boolean;
  counterpartName: string;
  totalMilestones: number;
  completedMilestones: number;
  autoAcceptLabel: string | null;
}

/** The derived engagement-row render facts. `href` is ALWAYS present. */
export interface EngagementRowDeriv {
  needsYou: boolean;
  nudgeLabel: string;
  href: string;
  progressLabel: string | null;
  moveKind: ExpertMoveKind | null;
  clientMoveKind: ClientMoveKind | null;
  deliveryState: EngagementDeliveryState;
}

/**
 * Compile-time exhaustiveness guard — a new engagement OR project-request status fails
 * typecheck here. Shared by `clientNeedsYou` (BAL-540) and `deriveEngagementRow`; generic
 * over `never` so one witness serves both enums.
 */
function assertNeverStatus(status: never): never {
  throw new Error(`Unhandled engagement or project-request status: ${String(status)}`);
}

/**
 * Pure engagement-row deriver (BAL-336, D6) — the (status × lens × change-note)
 * rule table for a post-kickoff delivery engagement in the A7 inbox. A total
 * function over the finite state space; the exhaustive `switch` has a `default` so
 * a future engagement status fails typecheck. `href` keys on the always-present
 * engagement id (retainer-safe — never the nullable projectRequestId). The route
 * matches D1/BAL-331's workspace `?from` entry whitelist (value `inbox`); typedRoutes
 * is OFF so it is a plain string.
 */
export function deriveEngagementRow(input: EngagementRowInput): EngagementRowDeriv {
  const href = `/engagements/${input.engagementId}?from=inbox`;
  const progressLabel =
    input.totalMilestones > 0
      ? `${input.completedMilestones} of ${input.totalMilestones} milestones`
      : null;

  switch (input.status) {
    case 'active': {
      if (input.hasChangeRequest) {
        if (input.lens === 'expert') {
          return {
            needsYou: true,
            nudgeLabel: `${input.counterpartName} requested changes`,
            href,
            progressLabel,
            moveKind: 'delivery_changes',
            clientMoveKind: null,
            deliveryState: 'changes_requested',
          };
        }
        return {
          needsYou: false,
          nudgeLabel: 'Changes requested',
          href,
          progressLabel,
          moveKind: null,
          clientMoveKind: null,
          deliveryState: 'changes_requested',
        };
      }
      return {
        needsYou: false,
        nudgeLabel: 'In delivery',
        href,
        progressLabel,
        moveKind: null,
        clientMoveKind: null,
        deliveryState: 'in_delivery',
      };
    }
    case 'pending_acceptance': {
      if (input.lens === 'client') {
        const nudgeLabel =
          input.autoAcceptLabel === null
            ? 'Review project completion'
            : `Review project completion — auto-accepts ${input.autoAcceptLabel}`;
        return {
          needsYou: true,
          nudgeLabel,
          href,
          progressLabel: null,
          moveKind: null,
          clientMoveKind: 'completion',
          deliveryState: 'pending_acceptance',
        };
      }
      return {
        needsYou: false,
        nudgeLabel: `Awaiting ${input.counterpartName} review`,
        href,
        progressLabel: null,
        moveKind: null,
        clientMoveKind: null,
        deliveryState: 'pending_acceptance',
      };
    }
    case 'completed':
      return {
        needsYou: false,
        nudgeLabel: 'Completed',
        href,
        progressLabel: null,
        moveKind: null,
        clientMoveKind: null,
        deliveryState: 'completed',
      };
    case 'cancelled':
      return {
        needsYou: false,
        nudgeLabel: 'Cancelled',
        href,
        progressLabel: null,
        moveKind: null,
        clientMoveKind: null,
        deliveryState: 'cancelled',
      };
    default:
      return assertNeverStatus(input.status);
  }
}

// ── Tile / filter helpers (used client-side by participant-dash) ───

/** Whether a row belongs to a given tile filter slice. */
export function rowMatchesFilter(row: PortfolioRowView, filter: PortfolioFilter): boolean {
  switch (filter) {
    case 'needs':
      return row.needsYou;
    case 'kicked':
      return row.stage === 'kicked';
    case 'in_progress':
      return !row.needsYou && row.stage !== 'kicked';
    case 'all':
    default:
      return true;
  }
}

/** Tile counts from a complete ranked row list. */
export function tilesFromRows(rows: ReadonlyArray<PortfolioRowView>): PortfolioDTO['tiles'] {
  const needs = rows.filter((r) => r.needsYou).length;
  const kicked = rows.filter((r) => r.stage === 'kicked').length;
  const inProgress = rows.filter((r) => !r.needsYou && r.stage !== 'kicked').length;
  return { needs, inProgress, kicked, total: rows.length };
}
