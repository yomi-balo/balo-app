import type { PortfolioRequestRow, PortfolioInvitationRow, PortfolioEngagementRow } from '@balo/db';
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
  | 'invited'
  | 'eoi'
  | 'prop_req'
  | 'prop_in'
  | 'accepted'
  | 'kicked';

/** The portfolio filter tiles (participant lenses). */
export type PortfolioFilter = 'all' | 'needs' | 'in_progress' | 'kicked';

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
  unread: boolean;
  /** "2 days ago" — relative label of the recency timestamp. */
  updatedRelative: string;
  /** ISO recency timestamp (sort key already applied server-side). */
  recencyAtIso: string;
  /** Freshest inbound signal preview, or null. */
  signal?: { from: string; messagePreview: string } | null;
  kind: 'request' | 'engagement';
}

/** Participant-lens DTO (client / expert). Fully serialisable (ISO + labels). */
export interface PortfolioDTO {
  lens: 'client' | 'expert';
  allowedLenses: PortfolioLens[];
  /** COMPLETE portfolio, ranked needs-you-first then recency desc. */
  rows: PortfolioRowView[];
  tiles: { needs: number; inProgress: number; kicked: number; total: number };
  isEmpty: boolean;
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
  invited: 'Experts invited',
  eoi: 'In conversation',
  prop_req: 'Proposal req.',
  prop_in: 'Proposals in',
  accepted: 'Accepted',
  kicked: 'Kicked off',
};

/** Request status → design stage key (the table in the plan §Stage chip mapping). */
const REQUEST_STATUS_TO_STAGE: Record<ProjectRequestStatus, StageKey> = {
  draft: 'requested',
  requested: 'requested',
  exploratory_meeting_requested: 'invited',
  experts_invited: 'invited',
  eoi_submitted: 'eoi',
  proposal_requested: 'prop_req',
  proposal_submitted: 'prop_in',
  accepted: 'accepted',
  kickoff_approved: 'kicked',
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
    invited: 0,
    eoi: 0,
    prop_req: 0,
    prop_in: 0,
    accepted: 0,
    kicked: 0,
  };
  for (const row of rows) dist[row.stage] += 1;
  return dist;
}

// ── Recency fold ───────────────────────────────────────────────────

/** Newest of a non-empty list of dates. */
function maxDate(seed: Date, more: ReadonlyArray<Date>): Date {
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
  freshestSignal: { from: string; messagePreview: string } | null;
}

const EMPTY_SIGNAL: RequestThreadSignal = {
  anyUnread: false,
  awaitingViewerReply: false,
  freshestSignal: null,
};

/** Count of relationships at `proposal_submitted` — "Review N proposals". */
function proposalSubmittedCount(row: PortfolioRequestRow): number {
  return row.relationships.filter((r) => r.status === 'proposal_submitted').length;
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

function clientNeedsYou(row: PortfolioRequestRow, signal: RequestThreadSignal): NeedsYouResult {
  switch (row.status) {
    case 'draft':
    case 'requested':
      return { needsYou: false, nudgeLabel: 'Waiting on Balo' };
    case 'exploratory_meeting_requested':
    case 'experts_invited':
      return { needsYou: false, nudgeLabel: 'Waiting on experts' };
    case 'eoi_submitted': {
      const needsYou = signal.anyUnread || signal.awaitingViewerReply;
      return {
        needsYou,
        nudgeLabel: needsYou ? `Reply to ${awaitingExpertName(signal)}` : 'In conversation',
      };
    }
    case 'proposal_requested':
      return { needsYou: false, nudgeLabel: 'Proposal in progress' };
    case 'proposal_submitted': {
      const count = proposalSubmittedCount(row);
      const label = count > 1 ? `Review ${count} proposals` : 'Review proposal';
      return { needsYou: true, nudgeLabel: label };
    }
    case 'accepted': {
      const gateOwed = row.clientBillingConfirmedAt === null;
      return {
        needsYou: gateOwed,
        nudgeLabel: gateOwed ? 'Confirm billing' : 'Awaiting kickoff',
      };
    }
    case 'kickoff_approved':
    default:
      return { needsYou: false, nudgeLabel: 'Live project' };
  }
}

// ── Expert lens needs-you + nudge (per-relationship) ───────────────

function expertNeedsYou(
  invitation: PortfolioInvitationRow,
  signal: RequestThreadSignal
): NeedsYouResult {
  // Request-level decision: if the request is accepted, the surviving thread owes
  // the kickoff gate; a non-accepted relationship on a decided request is lost.
  if (invitation.requestStatus === 'accepted' || invitation.requestStatus === 'kickoff_approved') {
    if (invitation.relationshipStatus === 'accepted') {
      if (invitation.requestStatus === 'kickoff_approved') {
        return { needsYou: false, nudgeLabel: 'Live project' };
      }
      // requestStatus 'accepted' + viewer is the accepted expert → confirm terms.
      // The expert lens does not carry the gate column, so the row is keyed on the
      // accepted status; the detail page enforces the actual gate flag.
      return { needsYou: true, nudgeLabel: 'Confirm terms' };
    }
    return { needsYou: false, nudgeLabel: 'Not selected' };
  }

  switch (invitation.relationshipStatus) {
    case 'invited':
      return { needsYou: true, nudgeLabel: 'Submit your EOI' };
    case 'eoi_submitted': {
      const needsReply = signal.anyUnread || signal.awaitingViewerReply;
      return {
        needsYou: true,
        nudgeLabel: needsReply ? 'Reply to client' : 'Propose times',
      };
    }
    case 'proposal_requested':
      return { needsYou: true, nudgeLabel: 'Build your proposal' };
    case 'proposal_submitted':
      return { needsYou: false, nudgeLabel: 'Waiting on client' };
    case 'accepted':
      return { needsYou: true, nudgeLabel: 'Confirm terms' };
    case 'declined':
    default:
      return { needsYou: false, nudgeLabel: 'Not selected' };
  }
}

// ── Admin lens needs-you + nudge ───────────────────────────────────

function adminNeedsYou(row: PortfolioRequestRow, now: Date): NeedsYouResult {
  switch (row.status) {
    case 'draft':
    case 'requested':
      return { needsYou: true, nudgeLabel: 'Triage' };
    case 'exploratory_meeting_requested':
    case 'experts_invited': {
      const stalled = adminStallDays(row, now);
      if (stalled !== null) {
        return { needsYou: true, nudgeLabel: `No EOIs · ${stalled}d` };
      }
      return { needsYou: false, nudgeLabel: 'Experts invited' };
    }
    case 'accepted': {
      const gateOwed = row.clientBillingConfirmedAt === null || row.expertTermsConfirmedAt === null;
      return { needsYou: gateOwed, nudgeLabel: gateOwed ? 'Kickoff gate' : 'Awaiting kickoff' };
    }
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
): NeedsYouResult {
  return lens === 'client' ? clientNeedsYou(row, signal) : adminNeedsYou(row, now);
}

/** Expert invitation-row needs-you + nudge resolution (per-relationship). */
export function needsYouForExpert(
  invitation: PortfolioInvitationRow,
  signal: RequestThreadSignal = EMPTY_SIGNAL
): NeedsYouResult {
  return expertNeedsYou(invitation, signal);
}

/** Expert engagement-row nudge — delivery is never needs-you. */
export function nudgeForEngagement(engagement: PortfolioEngagementRow): {
  needsYou: boolean;
  nudgeLabel: string;
  href: string | null;
} {
  return {
    needsYou: false,
    nudgeLabel: 'Live project',
    href: engagement.projectRequestId === null ? null : `/projects/${engagement.projectRequestId}`,
  };
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
