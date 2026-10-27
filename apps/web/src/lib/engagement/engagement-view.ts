import 'server-only';

import {
  AUTO_ACCEPT_DAYS,
  blocksMarkReady,
  type ChangeOrderWithLines,
  type MilestoneContentEditRow,
  type ProjectDeliveryStatus,
  type ProjectEngagementWithMilestones,
} from '@balo/db';
import { isContractedMilestone } from '@balo/shared/engagements';
import { applyBaloFee } from '@balo/shared/pricing';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { pricingMethodLabel } from '@/components/balo/project-request/proposal/proposal-summary-cells';
import {
  completionModalBody,
  MARK_READY_AGAIN_LABEL,
  deriveChangeRequestBanner,
  deriveChangeRequestState,
  deriveLastRequest,
  deriveMilestoneFeedback,
  deriveReviewPill,
  deriveSegments,
  type ChangeRequestState,
} from './change-request-view';
import { effectiveExpertPriceCents, findOpenOrder } from './change-order-view';
import { deriveProposalChanges, type ProposalContentChange } from './proposal-content-changes';
import {
  deriveEngagementParties,
  engagementHeaderLine,
  expertSideActorLabel,
  personAtCompany,
  projectEngagementTitle,
  type EngagementParties,
} from './engagement-parties';
import type {
  EngagementArchetype,
  EngagementLens,
  EngagementViewerContext,
} from './resolve-engagement-lens';

// Re-exported so every workspace component can import the parties slice type from
// the same single view module (the contract's one-stop import site) rather than
// reaching into `engagement-parties` directly.
export type { EngagementParties } from './engagement-parties';

/**
 * The delivery workspace's single serializable contract. `mapEngagementToWorkspaceView`
 * (server-only — it value-imports `AUTO_ACCEPT_DAYS` from `@balo/db`) produces THIS
 * object once, and EVERY component consumes a slice of it. Components must NOT touch
 * `@balo/db`, NOT recompute copy, and NOT reach for the raw read model — every
 * derived string / flag they need already lives here.
 *
 * READ-ONLY slice (BAL-331 / D1): no mutation affordances are modelled; the view
 * carries state + navigational hrefs only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days without delivery activity after which the admin chip flags the project. */
export const DELIVERY_QUIET_THRESHOLD_DAYS = 14;

/**
 * The workspace's status union. Re-pointed at the schema-derived
 * `ProjectDeliveryStatus` by BAL-417 rather than re-declared as four literals, so it
 * can never drift from the `project_delivery_status` pgEnum again.
 *
 * ⚠ This is the PROJECT DELIVERY status (4 labels, incl. `pending_acceptance`), NOT
 * the coarse 3-label supertype `engagements.status`. Widening it to the supertype
 * union would silently delete `pending_acceptance` from every switch below — the
 * in-review state the whole review-banner / countdown / completion-card surface is
 * built on.
 */
export type EngagementWorkspaceStatus = ProjectDeliveryStatus;

/** Semantic tone → the component maps to `text-success` / `text-warning` / etc. */
export type StatusTone = 'success' | 'warning' | 'neutral' | 'destructive';

/** Milestone rail node kind (== milestone status). */
export type MilestoneNodeVariant = 'pending' | 'in_progress' | 'completed';

/** Lucide icon name carried by the view (component maps name → icon component). */
export type ViewIcon =
  | 'Layers'
  | 'Clock'
  | 'Check'
  | 'Ban'
  | 'DollarSign'
  | 'CalendarDays'
  | 'FileText'
  | 'Target'
  | 'Flag'
  | 'Receipt';

export interface StatusChipView {
  status: EngagementWorkspaceStatus;
  /** e.g. "Active", "Awaiting client review", "Completed", "Cancelled". */
  label: string;
  tone: StatusTone;
  icon: ViewIcon;
}

export interface TermsStripItem {
  icon: ViewIcon;
  /** Accessible descriptor, e.g. "Pricing" | "Timeframe" | "Kicked off". */
  label: string;
  /** Display text, e.g. "Fixed price · A$58,000". */
  value: string;
  /** Present only when the pill needs attention; absent renders it neutral. */
  tone?: 'warning';
}

export interface ProvenanceLinkView {
  requestId: string;
  /** `/projects/{requestId}` — the source request. Null for retainers. */
  href: string;
}

export interface EngagementHeaderView {
  engagementTitle: string;
  /** Per-lens sub-line (parties util). */
  headerLine: string;
  statusChip: StatusChipView;
  /** Optional — retainers have no source request. */
  provenance: ProvenanceLinkView | null;
  /** Snapshotted commercial terms (0..3 pills). */
  terms: TermsStripItem[];
  /** Back-link target. */
  backHref: string;
}

/** The project-level review pill beside the progress count. */
export interface ReviewPillView {
  label: string;
  tone: 'warning' | 'violet' | 'success';
}

/** One milestone's segment in the progress bar. `reopened` = tagged by the open change request. */
export interface ProgressSegmentView {
  id: string;
  tone: 'completed' | 'in_progress' | 'pending' | 'reopened';
  /** Accessible name + tooltip, e.g. "Build: Changes requested". */
  label: string;
}

export interface EngagementProgressView {
  done: number;
  total: number;
  /** 0..100, rounded. Feeds the accessible `<progress>` only — never rendered as text. */
  pct: number;
  /** Client-lens whole-project review explainer; null for expert/admin. */
  reviewCopy: string | null;
  /** Null when the project is neither in change-request, in review nor accepted. */
  reviewPill: ReviewPillView | null;
  /** One per live milestone, in plan order. */
  segments: ProgressSegmentView[];
}

/** The client's feedback on a milestone the latest change request tagged. */
export interface MilestoneFeedbackView {
  /** "Your feedback · 6 Jul" | "Dana @ Northwind requested changes · 6 Jul". */
  calloutHeading: string;
  note: string;
  /** Chip text once the milestone is completed again. */
  addressedLabel: string;
}

export interface MilestoneNodeView {
  id: string;
  title: string;
  /** Server-sanitised HTML — injected as-is by the shared `MilestoneRow`. Null if none. */
  descriptionHtml: string | null;
  /**
   * Plain-text of `descriptionHtml` (server-derived via `htmlToPlainText`) — the edit
   * form modal prefills from THIS so the client never touches server-only HTML. Null
   * when the description is blank.
   */
  descriptionText: string | null;
  acceptanceCriteria: string | null;
  status: MilestoneNodeVariant;
  nodeVariant: MilestoneNodeVariant;
  /** "Not started" | "In progress" | "Completed". */
  statusLabel: string;
  /** The connector segment BELOW this node is gradient-filled (node completed). */
  connectorFilled: boolean;
  /** Snapshotted milestone value, e.g. "A$14,500"; null when 0 / unset. */
  valueLabel: string | null;
  /** "Started 16 Jun"; null when not started. */
  startedLabel: string | null;
  /** "Completed 30 Jun by Priya"; null when not completed. */
  completedLabel: string | null;
  /** The "Delivered:" trust artifact; null unless completed with a note. */
  completionNote: string | null;
  /** Set when the latest change-request round tagged this milestone; null otherwise. */
  feedback: MilestoneFeedbackView | null;
  /** An edit or remove line of the open SENT change order targets it, so plain edits are locked. */
  changePending: boolean;
  /** An approved change order added (`added`) or edited (`updated`) this milestone. */
  changeProvenance: 'added' | 'updated' | null;
  /** Wording the expert revised after the proposal was accepted; empty means no chip. */
  proposalChanges: ProposalContentChange[];
  /** Fixed price only: removing this milestone needs the client's approval, so Remove explains that up front. */
  removalNeedsChangeOrder: boolean;
}

/**
 * BAL-338 (D7) — the client's project-level decision copy, pre-derived server-side so
 * the client action island stays a primitive-props surface (never value-imports
 * `@balo/db` / recomputes `AUTO_ACCEPT_DAYS` or party names). Non-null ONLY on the
 * client lens.
 */
export interface ReviewClientDecisionView {
  /** Sticky accept-confirm modal body — invoice consequence + irreversibility. */
  acceptModalBody: string;
  /** Request-changes modal intro — window restarts + who's notified. */
  requestChangesIntro: string;
  /** The note-field hint, party-named ("…exactly what {expert} sees"). */
  requestChangesFieldHint: string;
  /** The live milestones the client may tag on a change request. */
  milestoneOptions: { id: string; title: string }[];
  /** The helper line under the milestone picker, party-named. */
  milestoneHelper: string;
}

export interface ReviewBannerView {
  title: string;
  body: string;
  /** Formatted auto-accept date, e.g. "11 Jul 2026"; null only if the request timestamp is absent. */
  autoAcceptOn: string | null;
  /** Client-lens only: the accept / request-changes decision copy; null for expert/admin. */
  clientDecision: ReviewClientDecisionView | null;
  /** Client lens, after a change request: the previous round's note. Null otherwise. */
  lastRequest: { heading: string; note: string } | null;
  /** Client lens only: milestones whose wording changed since the proposal; null when none. */
  changedSinceProposal: ChangedSinceProposalView | null;
}

export interface ChangedSinceProposalView {
  heading: string;
  intro: string;
  items: { milestoneId: string; milestoneTitle: string; fieldsLabel: string }[];
}

/**
 * The open change request, as a status banner on an `active` project. Derived from the
 * LATEST round (never the legacy `change_request_note`, which `requestCompletion` nulls).
 *  - `work_outstanding` — the expert still has work to do; carries no CTA. Admins always
 *    get this variant, with a guidance line saying so once the changes are made.
 *  - `changes_made`     — every tagged milestone is done again; carries the one CTA.
 *  - `client_waiting`   — the client's own view of the same state.
 */
export type ChangeRequestBannerView =
  | { variant: 'work_outstanding'; headline: string; quote: string; guidance: string | null }
  | {
      variant: 'changes_made';
      headline: string;
      reminder: string;
      ctaLabel: string;
      modalBody: string;
    }
  | { variant: 'client_waiting'; body: string };

/**
 * BAL-338 (D7) — the client's next-step CTAs on the completed banner: "Start your next
 * project" (opens the context-free project request panel — no data needed here) and Message →
 * the source request's conversation. The v2 marketplace hooks (review-request, rehire shortcut)
 * slot into this same row. Non-null ONLY on the client lens.
 */
export interface CompletedBannerClientCtaView {
  /** "Message {person}" — the source request's conversation; null for retainers (no request). */
  messageHref: string | null;
  /** Full person label for the Message CTA, e.g. "Priya Sharma". */
  messagePersonLabel: string;
}

export interface CompletedBannerView {
  title: string;
  body: string;
  /** Admin-only "Ready to invoice" affordance flag. */
  readyToInvoice: boolean;
  /** Client-lens only: next-step CTAs; null for expert/admin. */
  clientCta: CompletedBannerClientCtaView | null;
}

export interface CancelledBannerView {
  title: string;
  /** "Cancelled by Balo on {date}." */
  body: string;
  reason: string | null;
}

export interface EmptyStateView {
  title: string;
  body: string;
  icon: ViewIcon;
}

/** The cancel-project dialog's pre-derived copy; non-null while the project can still be cancelled. */
export interface CancelDialogView {
  body: string;
  reasonHint: string;
  /** Pending acceptance only: what the review in progress means for the cancellation. */
  reviewNote: string | null;
}

export interface CompletionCardView {
  /** The engagement has ≥1 live milestone (vs the retainer/embedded zero case). */
  hasMilestones: boolean;
  /** Live milestones still to complete (total − done), clamped ≥ 0. */
  milestonesRemaining: number;
  milestonesTotal: number;
  /** The finish button is enabled: zero milestones OR every milestone done. */
  canRequest: boolean;
  /** Pre-derived card body — one of the three variants (zero / allDone / blocked). */
  bodyCopy: string;
  /** Pre-derived request-completion modal body (window + plan-lock + invoice copy). */
  modalBody: string;
  /** "Mark project ready" | "Mark project ready again" (a change request is behind it). */
  ctaLabel: string;
}

export interface EngagementWorkspaceView {
  engagementId: string;
  lens: EngagementLens;
  archetype: EngagementArchetype;
  status: EngagementWorkspaceStatus;
  isClientOwner: boolean;
  isDeliveringExpert: boolean;
  header: EngagementHeaderView;
  parties: EngagementParties;
  progress: EngagementProgressView;
  milestones: MilestoneNodeView[];
  hasMilestones: boolean;
  reviewBanner: ReviewBannerView | null;
  changeRequestBanner: ChangeRequestBannerView | null;
  completedBanner: CompletedBannerView | null;
  cancelledBanner: CancelledBannerView | null;
  emptyState: EmptyStateView | null;
  /** Non-null for an active or pending-acceptance project; the page decides who may open it. */
  cancelDialog: CancelDialogView | null;
  /** Expert-lens + active only: the "Finish the project" card (D4); null otherwise. */
  completionCard: CompletionCardView | null;
  /** Time-and-materials: new milestones need the client's approval, so "Add milestone" is hidden. */
  addMilestoneNeedsChangeOrder: boolean;
}

// ── Date / relative helpers (deterministic under TZ=UTC) ─────────────────────

/** "16 Jun" — day + short month, UTC. */
function formatShortDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/** "30 Aug 2026" — day + short month + year, UTC. */
function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Whole days between `from` and `now` (never negative). */
function wholeDaysSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

/** "today" | "1d ago" | "Nd ago". */
function formatRelativeDays(from: Date, now: Date): string {
  const days = wholeDaysSince(from, now);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

// ── Derivations ──────────────────────────────────────────────────────────────

function deriveStatusChip(status: EngagementWorkspaceStatus): StatusChipView {
  switch (status) {
    case 'active':
      return { status, label: 'Active', tone: 'success', icon: 'Layers' };
    case 'pending_acceptance':
      return { status, label: 'Awaiting client review', tone: 'warning', icon: 'Clock' };
    case 'completed':
      return { status, label: 'Completed', tone: 'success', icon: 'Check' };
    case 'cancelled':
      return { status, label: 'Cancelled', tone: 'destructive', icon: 'Ban' };
  }
}

/**
 * Terms-strip "timeframe" is derived honestly (the proposal's "~10 weeks" is NOT
 * snapshotted, so it is not reproducible): a retainer cadence humanises to
 * "Monthly retainer"; otherwise Σ live-milestone `estimatedMinutes` → "~Nh
 * estimated"; otherwise the pill is OMITTED (the strip tolerates optional pills).
 */
function deriveTimeframeItem(engagement: ProjectEngagementWithMilestones): TermsStripItem | null {
  if (engagement.cadence !== null) {
    return {
      icon: 'Clock',
      label: 'Timeframe',
      value: engagement.cadence === 'monthly' ? 'Monthly retainer' : 'Fortnightly retainer',
    };
  }
  const totalMinutes = engagement.milestones.reduce(
    (sum, m) =>
      sum + (m.estimatedMinutes !== null && m.estimatedMinutes > 0 ? m.estimatedMinutes : 0),
    0
  );
  if (totalMinutes > 0) {
    return {
      icon: 'Clock',
      label: 'Timeframe',
      value: `~${Math.round(totalMinutes / 60)}h estimated`,
    };
  }
  return null;
}

function deriveTermsStrip(
  engagement: ProjectEngagementWithMilestones,
  lens: EngagementLens,
  changeOrders: readonly ChangeOrderWithLines[]
): TermsStripItem[] {
  const kickedOffAt = engagement.activatedAt ?? engagement.createdAt;
  const kickedOff: TermsStripItem = {
    icon: 'CalendarDays',
    label: 'Kicked off',
    value: `Kicked off ${formatShortDate(kickedOffAt)}`,
  };
  // Time and materials bills hours worked, so the strip states the method and the billing
  // cadence and never an amount.
  if (engagement.pricingMethod === 'tm') {
    const items: TermsStripItem[] = [
      { icon: 'DollarSign', label: 'Pricing', value: pricingMethodLabel('tm') },
    ];
    if (engagement.cadence !== null) {
      items.push({
        icon: 'Receipt',
        label: 'Billing',
        value: `Billed ${engagement.cadence}`,
      });
    }
    items.push(kickedOff);
    return items;
  }
  // The EFFECTIVE price: the accepted price plus every approved change order's delta.
  // Client sees the marked-up (grossed-up) figure, derived on read from the snapshotted
  // `baloFeeBps`; expert & admin see the RAW payout quote.
  const effectiveCents = effectiveExpertPriceCents(engagement.priceCents, changeOrders);
  const priceCents =
    lens === 'client' ? applyBaloFee(effectiveCents, engagement.baloFeeBps) : effectiveCents;
  const items: TermsStripItem[] = [
    {
      icon: 'DollarSign',
      label: 'Pricing',
      // `pricingMethodLabel` is the shared definition (BAL-392): the same strings over
      // the same `pricing_method` enum have ONE home, read by the proposal PDF, the
      // proposal doc, and this post-acceptance terms strip.
      value: `${pricingMethodLabel(engagement.pricingMethod)} · ${formatWholeCurrency(
        priceCents,
        engagement.currency
      )}`,
    },
  ];
  const timeframe = deriveTimeframeItem(engagement);
  if (timeframe !== null) items.push(timeframe);

  items.push(kickedOff);
  return items;
}

/** The milestone ids the open SENT change order edits or removes (locked while it is decided). */
function pendingMilestoneIds(changeOrders: readonly ChangeOrderWithLines[]): Set<string> {
  const open = findOpenOrder(changeOrders);
  const ids = new Set<string>();
  if (open?.status !== 'sent') return ids;
  for (const line of open.lines) {
    if (line.op !== 'add' && line.engagementMilestoneId !== null)
      ids.add(line.engagementMilestoneId);
  }
  return ids;
}

/** Which approved change order added or edited each milestone ('added' wins over 'updated'). */
function milestoneProvenance(
  changeOrders: readonly ChangeOrderWithLines[]
): Map<string, 'added' | 'updated'> {
  const provenance = new Map<string, 'added' | 'updated'>();
  for (const order of changeOrders) {
    if (order.status !== 'approved') continue;
    for (const line of order.lines) {
      if (line.op === 'remove' || line.engagementMilestoneId === null) continue;
      if (line.op === 'add' || !provenance.has(line.engagementMilestoneId)) {
        provenance.set(line.engagementMilestoneId, line.op === 'add' ? 'added' : 'updated');
      }
    }
  }
  return provenance;
}

function groupContentEdits(
  rows: readonly MilestoneContentEditRow[]
): Map<string, MilestoneContentEditRow[]> {
  const grouped = new Map<string, MilestoneContentEditRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.milestoneId);
    if (list === undefined) grouped.set(row.milestoneId, [row]);
    else list.push(row);
  }
  return grouped;
}

function deriveMilestones(
  engagement: ProjectEngagementWithMilestones,
  parties: EngagementParties,
  lens: EngagementLens,
  crState: ChangeRequestState,
  changeOrders: readonly ChangeOrderWithLines[],
  contentEdits: readonly MilestoneContentEditRow[]
): MilestoneNodeView[] {
  const pending = pendingMilestoneIds(changeOrders);
  const provenance = milestoneProvenance(changeOrders);
  const editsByMilestone = groupContentEdits(contentEdits);
  const statusLabels: Record<MilestoneNodeVariant, string> = {
    pending: 'Not started',
    in_progress: 'In progress',
    completed: 'Completed',
  };
  return engagement.milestones.map((m) => {
    const isCompleted = m.status === 'completed';
    // Gate on the RAW snapshotted value; client sees it grossed up by the Balo fee,
    // expert & admin see the raw payout figure.
    const rawValue = m.valueCents;
    let valueLabel: string | null = null;
    if (rawValue !== null && rawValue > 0) {
      const displayValue =
        lens === 'client' ? applyBaloFee(rawValue, engagement.baloFeeBps) : rawValue;
      valueLabel = formatWholeCurrency(displayValue, engagement.currency);
    }
    // Plain-text of the raw description for the expert edit-form prefill — kept out
    // of the client's hands as HTML (the modal only sees text). Blank/tag-only → null.
    const descriptionText =
      m.descriptionHtml !== null && m.descriptionHtml.trim() !== ''
        ? htmlToPlainText(m.descriptionHtml) || null
        : null;
    return {
      id: m.id,
      title: m.title,
      descriptionText,
      // Sanitise ONCE here (the mapper is server-only) so both the read-only rail and
      // the client `ExpertMilestoneRail` inject already-safe HTML — the client-safe
      // `MilestoneRow` cannot call the `server-only` `RichText`/`sanitizeProjectHtml`.
      // Preserves the two-layer guarantee: ingest sanitise + mapper sanitise.
      descriptionHtml:
        m.descriptionHtml !== null && m.descriptionHtml.trim() !== ''
          ? sanitizeProjectHtml(m.descriptionHtml)
          : null,
      acceptanceCriteria:
        m.acceptanceCriteria !== null && m.acceptanceCriteria.trim() !== ''
          ? m.acceptanceCriteria
          : null,
      status: m.status,
      nodeVariant: m.status,
      statusLabel: statusLabels[m.status],
      connectorFilled: isCompleted,
      valueLabel,
      startedLabel: m.startedAt === null ? null : `Started ${formatShortDate(m.startedAt)}`,
      completedLabel:
        m.completedAt === null
          ? null
          : `Completed ${formatShortDate(m.completedAt)} by ${parties.expertPersonShort}`,
      completionNote:
        isCompleted && m.completionNote !== null && m.completionNote.trim() !== ''
          ? m.completionNote
          : null,
      feedback: deriveMilestoneFeedback(engagement, crState, m.id, lens),
      changePending: pending.has(m.id),
      changeProvenance: provenance.get(m.id) ?? null,
      proposalChanges:
        m.contentEditedAt === null
          ? []
          : deriveProposalChanges(m, editsByMilestone.get(m.id) ?? []),
      removalNeedsChangeOrder:
        engagement.pricingMethod === 'fixed' &&
        isContractedMilestone(m, provenance.get(m.id) === 'added'),
    };
  });
}

function deriveProgress(
  engagement: ProjectEngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties,
  crState: ChangeRequestState
): EngagementProgressView {
  const total = engagement.milestones.length;
  const done = engagement.milestones.filter((m) => m.status === 'completed').length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  // The forward-looking "…you review it — accept, or request changes" explainer
  // only makes sense while the project is still in flight; on terminal
  // (completed/cancelled) engagements it would render a stale caption beneath the
  // CompletedBanner/CancelledBanner. Gate it to non-terminal client views.
  const isNonTerminal =
    engagement.status === 'active' || engagement.status === 'pending_acceptance';
  const reviewCopy =
    lens === 'client' && isNonTerminal && !crState.outstanding
      ? `${parties.expertPartyShort} marks each milestone as it's delivered. When the whole project is done, you review it — accept, or request changes within ${AUTO_ACCEPT_DAYS} days.`
      : null;
  return {
    done,
    total,
    pct,
    reviewCopy,
    reviewPill: deriveReviewPill(engagement, lens, parties, crState),
    segments: deriveSegments(engagement, crState),
  };
}

/** The review card's list of revised milestones, or null when nothing changed. */
function deriveChangedSinceProposal(
  milestones: readonly MilestoneNodeView[],
  parties: EngagementParties
): ChangedSinceProposalView | null {
  const changed = milestones.filter((m) => m.proposalChanges.length > 0);
  if (changed.length === 0) return null;
  const noun = changed.length === 1 ? 'milestone' : 'milestones';
  return {
    heading: 'Changed since proposal',
    intro: `${parties.expertRetroFirstMention} revised the wording of ${changed.length} ${noun} after the proposal was accepted. Each is marked below.`,
    items: changed.map((m) => ({
      milestoneId: m.id,
      milestoneTitle: m.title,
      fieldsLabel: m.proposalChanges.map((change) => change.label).join(', '),
    })),
  };
}

/** The formatted date the project is accepted automatically; null without a completion request. */
function autoAcceptDate(engagement: ProjectEngagementWithMilestones): string | null {
  const requestedAt = engagement.completionRequestedAt;
  if (requestedAt === null) return null;
  return formatLongDate(new Date(requestedAt.getTime() + AUTO_ACCEPT_DAYS * DAY_MS));
}

/** "on 11 Jul 2026", or the window's end when the request date is missing. */
function acceptedWhenPhrase(autoAcceptOn: string | null): string {
  return autoAcceptOn === null ? 'at the end of the review window' : `on ${autoAcceptOn}`;
}

/** Who marked the project ready, named as the acting person; no recorded person → the expert side. */
function completionRequesterLabel(
  engagement: ProjectEngagementWithMilestones,
  parties: EngagementParties
): string {
  return expertSideActorLabel(engagement, parties, engagement.completionRequestedBy);
}

function deriveReviewBanner(
  engagement: ProjectEngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties,
  milestones: readonly MilestoneNodeView[]
): ReviewBannerView | null {
  if (engagement.status !== 'pending_acceptance') return null;

  const requestedAt = engagement.completionRequestedAt;
  const autoAcceptOn = autoAcceptDate(engagement);
  const acceptedWhen = acceptedWhenPhrase(autoAcceptOn);
  const requestedAtLabel = requestedAt === null ? 'recently' : formatShortDate(requestedAt);

  if (lens === 'client') {
    const expertShort = parties.expertPersonShort;
    return {
      title: `${completionRequesterLabel(engagement, parties)} says the project is ready`,
      body: `Have a look through the milestones below, then accept the project or request changes. If you don't respond, it's accepted ${acceptedWhen}.`,
      autoAcceptOn,
      lastRequest: deriveLastRequest(engagement),
      changedSinceProposal: deriveChangedSinceProposal(milestones, parties),
      clientDecision: {
        acceptModalBody: `Accepting confirms ${expertShort} delivered the project as agreed — it can't be un-accepted afterwards, and Balo raises the final invoice from here. If something's not right, request changes instead. ${expertShort} and the Balo team are notified.`,
        requestChangesIntro: `The project goes back to active with your note attached — ${expertShort} and the Balo team are notified, and the project is marked ready again once it's fixed. The ${AUTO_ACCEPT_DAYS}-day review window restarts then.`,
        requestChangesFieldHint: `Be specific — this is exactly what ${expertShort} sees.`,
        milestoneOptions: engagement.milestones.map((m) => ({ id: m.id, title: m.title })),
        milestoneHelper: `Milestones you pick go back to ${parties.expertPartyShort} with your feedback. If you don't pick any, ${parties.expertPartyShort} works out what needs to change.`,
      },
    };
  }
  if (lens === 'expert') {
    return {
      title: `Completion requested — awaiting ${parties.clientCompanyName}'s review`,
      body: `Requested ${requestedAtLabel}. The delivery plan is locked while the project is in review. If ${parties.clientCompanyName} doesn't respond, it's accepted ${acceptedWhen} and the final invoice is raised then.`,
      autoAcceptOn,
      clientDecision: null,
      lastRequest: null,
      changedSinceProposal: null,
    };
  }
  return {
    title: `Completion requested — awaiting ${parties.clientCompanyName}'s review`,
    body: `Requested ${requestedAtLabel} by ${completionRequesterLabel(engagement, parties)}. If ${parties.clientCompanyName} doesn't respond, it's accepted ${acceptedWhen} and the final invoice is raised then.`,
    autoAcceptOn,
    clientDecision: null,
    lastRequest: null,
    changedSinceProposal: null,
  };
}

/** "1 milestone" / "N milestones" — pluralized milestone count for the completed banner. */
function milestoneCountLabel(total: number): string {
  return `${total} ${total === 1 ? 'milestone' : 'milestones'}`;
}

/** Expert completed-banner lead — zero-milestone-safe. */
function completedDeliveredLead(total: number): string {
  return total === 0 ? 'The project was delivered' : `All ${milestoneCountLabel(total)} delivered`;
}

/** Admin completed-banner milestone suffix — empty when there are no milestones. */
function completedDeliveredSuffix(total: number): string {
  return total === 0 ? '' : ` — ${milestoneCountLabel(total)} delivered`;
}

function deriveCompletedBanner(
  engagement: ProjectEngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties
): CompletedBannerView | null {
  if (engagement.status !== 'completed') return null;
  const total = engagement.milestones.length;
  const acceptedAtLabel =
    engagement.acceptedAt === null ? 'the review date' : formatLongDate(engagement.acceptedAt);
  const isAuto = engagement.acceptanceMethod === 'auto' || engagement.acceptedBy === null;
  const acceptedLine = isAuto
    ? `accepted automatically on ${acceptedAtLabel} after the ${AUTO_ACCEPT_DAYS}-day review window`
    : `accepted by ${personAtCompany(engagement.acceptedBy, parties.clientCompanyName)} on ${acceptedAtLabel}`;

  if (lens === 'expert') {
    return {
      title: 'Project delivered',
      body: `${completedDeliveredLead(total)} and the project ${acceptedLine}. Balo has been notified.`,
      readyToInvoice: false,
      clientCta: null,
    };
  }
  if (lens === 'client') {
    return {
      title: 'Project completed',
      body: isAuto
        ? `The project was ${acceptedLine}. Balo will be in touch about the final invoice.`
        : `You accepted the project on ${acceptedAtLabel}. Balo will be in touch about the final invoice.`,
      readyToInvoice: false,
      clientCta: {
        messageHref:
          engagement.projectRequest === null ? null : `/projects/${engagement.projectRequest.id}`,
        messagePersonLabel: parties.expertPerson,
      },
    };
  }
  return {
    title: 'Project completed',
    body: `Project ${acceptedLine}${completedDeliveredSuffix(total)}.`,
    readyToInvoice: true,
    clientCta: null,
  };
}

/**
 * BAL-587 — does the project workspace offer the in-app rating card? A pure VIEW
 * decision: true only for a `completed` engagement on the CLIENT lens. Authorization
 * for the write stays entirely in `applyReview` (`app/review/_actions/review-write-shared.ts`)
 * — this predicate adds no second check, it only decides whether the read-and-render
 * path runs at all. Admin is false even when `isClientOwner` happens to be true (the
 * lens, not the ownership flag, decides — mirrors `resolveEngagementLens`'s precedence).
 */
export function offersRatingCard(status: EngagementWorkspaceStatus, lens: EngagementLens): boolean {
  return status === 'completed' && lens === 'client';
}

function deriveCancelledBanner(
  engagement: ProjectEngagementWithMilestones
): CancelledBannerView | null {
  if (engagement.status !== 'cancelled') return null;
  const cancelledAtLabel =
    engagement.cancelledAt === null ? 'an earlier date' : formatLongDate(engagement.cancelledAt);
  const reason =
    engagement.cancellationReason !== null && engagement.cancellationReason.trim() !== ''
      ? engagement.cancellationReason
      : null;
  return {
    title: 'Project cancelled',
    body: `Cancelled by Balo on ${cancelledAtLabel}.`,
    reason,
  };
}

function deriveEmptyState(
  engagement: ProjectEngagementWithMilestones,
  ctx: EngagementViewerContext,
  parties: EngagementParties
): EmptyStateView | null {
  if (engagement.milestones.length > 0) return null;
  // Terminal engagements show only their completed/cancelled banner — a
  // forward-looking "shaping the delivery plan" invitation would be stale.
  if (engagement.status === 'completed' || engagement.status === 'cancelled') return null;
  if (ctx.lens === 'expert') {
    const client = parties.clientCompanyName;
    // The delivering expert is addressed directly; an agency owner/admin viewing the same
    // plan is told what the agency does (prospective copy names the party).
    const firstMilestone = ctx.isDeliveringExpert ? 'your first milestone' : 'the first milestone';
    // On T&M a milestone is added through a change the client approves, so the invitation
    // matches the "Propose the first milestone" CTA.
    const opener =
      engagement.pricingMethod === 'tm'
        ? `Propose the first milestone — ${client} approves it before work is tracked against it.`
        : `Add ${firstMilestone} so ${client} can follow progress.`;
    const closer = ctx.isDeliveringExpert
      ? `you mark the project ready and ${client} reviews it as a whole.`
      : `${parties.expertPartyShort} marks the project ready and ${client} reviews it as a whole.`;
    return {
      icon: 'Flag',
      title: 'Shape the delivery plan',
      body: `${opener} When everything is delivered, ${closer}`,
    };
  }
  if (ctx.lens === 'client') {
    return {
      icon: 'Flag',
      title: `${parties.expertPartyShort} is shaping the delivery plan`,
      body: `Milestones appear here as ${parties.expertPartyShort} adds them, and you'll be notified as each one is delivered. When the whole project is marked complete, you review and accept it. Anything you want tracked as a milestone? Mention it in Messages.`,
    };
  }
  return {
    icon: 'Flag',
    title: 'No delivery plan yet',
    body: `The accepted proposal had no milestones, and ${parties.expertPartyShort} hasn't added any. The project can still be completed — but a nudge toward a visible plan keeps ${parties.clientCompanyName} confident.`,
  };
}

/**
 * Latest delivery-signal timestamp: milestone starts / completions, activation, the completion
 * request, and the most recent time logged.
 */
function deriveLastActivityAt(
  engagement: ProjectEngagementWithMilestones,
  lastTimeLoggedAt: Date | null
): Date {
  // `createdAt` always exists, so it seeds the fold — the reduce can never run on
  // an empty array (S6959) while still yielding the max of every delivery signal.
  const candidates: Date[] = [];
  if (engagement.activatedAt !== null) candidates.push(engagement.activatedAt);
  if (engagement.completionRequestedAt !== null) candidates.push(engagement.completionRequestedAt);
  if (lastTimeLoggedAt !== null) candidates.push(lastTimeLoggedAt);
  for (const m of engagement.milestones) {
    if (m.startedAt !== null) candidates.push(m.startedAt);
    if (m.completedAt !== null) candidates.push(m.completedAt);
  }
  return candidates.reduce(
    (latest, d) => (d.getTime() > latest.getTime() ? d : latest),
    engagement.createdAt
  );
}

/**
 * The admin header chip for an in-flight project: how long since anything moved. Once
 * delivery has been quiet for `DELIVERY_QUIET_THRESHOLD_DAYS`, the chip turns to a warning
 * that suggests a check-in.
 */
function deriveLastActivityChip(
  engagement: ProjectEngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties,
  now: Date,
  lastTimeLoggedAt: Date | null
): TermsStripItem | null {
  if (lens !== 'admin') return null;
  if (engagement.status !== 'active' && engagement.status !== 'pending_acceptance') return null;
  const lastActivityAt = deriveLastActivityAt(engagement, lastTimeLoggedAt);
  const quietDays = wholeDaysSince(lastActivityAt, now);
  if (quietDays >= DELIVERY_QUIET_THRESHOLD_DAYS) {
    return {
      icon: 'Clock',
      label: 'Last delivery activity',
      value: `Quiet for ${quietDays} days · worth a check-in with ${parties.expertPartyShort}`,
      tone: 'warning',
    };
  }
  return {
    icon: 'Clock',
    label: 'Last delivery activity',
    value: `Last delivery activity: ${formatRelativeDays(lastActivityAt, now)}`,
  };
}

/**
 * The cancel dialog's copy, for a project that can still be cancelled. Whether the viewer may
 * open it is the page's capability decision, not part of this view.
 */
function deriveCancelDialog(
  engagement: ProjectEngagementWithMilestones,
  parties: EngagementParties
): CancelDialogView | null {
  if (engagement.status !== 'active' && engagement.status !== 'pending_acceptance') return null;
  const client = parties.clientCompanyName;
  const reviewNote =
    engagement.status === 'pending_acceptance'
      ? `${completionRequesterLabel(engagement, parties)} has marked the project ready and ${client} is reviewing it. If they don't respond, it's accepted ${acceptedWhenPhrase(autoAcceptDate(engagement))}.`
      : null;
  return {
    body: `Delivery stops straight away for ${client} and ${parties.expertParty}, and it can't be undone. Both are told, with your reason.`,
    reasonHint: `${client} and ${parties.expertParty} both see this.`,
    reviewNote,
  };
}

/**
 * The expert "Finish the project" card (D4) — derived server-side, gated to the
 * EXPERT lens on an `active` engagement (else null; the plan locks during review /
 * terminal states). Copy is pre-derived here (incl. `AUTO_ACCEPT_DAYS`, party-named
 * via `clientCompanyName`) so the client island stays a primitive-props impression
 * surface and never value-imports `@balo/db`.
 */
function deriveCompletionCard(
  engagement: ProjectEngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties,
  crState: ChangeRequestState,
  changeOrders: readonly ChangeOrderWithLines[]
): CompletionCardView | null {
  if (lens !== 'expert') return null;
  if (engagement.status !== 'active') return null;
  // The `changes_made` banner carries the one "Mark project ready again" control, so the
  // card steps aside rather than offering a second identical button.
  if (crState.changesMade) return null;

  const total = engagement.milestones.length;
  const done = engagement.milestones.filter((m) => m.status === 'completed').length;
  const remaining = Math.max(0, total - done);
  const hasMilestones = total > 0;
  const allDone = remaining === 0;
  const open = findOpenOrder(changeOrders);
  const blocker = open !== null && blocksMarkReady(open) ? open : null;
  const canRequest = (total === 0 || allDone) && blocker === null;
  const client = parties.clientCompanyName;

  let bodyCopy: string;
  if (blocker !== null) {
    bodyCopy =
      blocker.status === 'sent'
        ? `A change is waiting on ${client}. You can mark the project ready once it's decided.`
        : `Answer ${client}'s change request first. The project can't be marked ready while it's open.`;
  } else if (total === 0) {
    bodyCopy = `This project has no milestones — you can still send it for ${client}'s review, but a visible plan builds trust.`;
  } else if (allDone) {
    bodyCopy = `Every milestone is delivered. Marking it ready sends the project to ${client} for review — ${client} can accept or request changes within ${AUTO_ACCEPT_DAYS} days, after which it's accepted automatically.`;
  } else {
    bodyCopy = `${remaining} of ${total} milestone${total === 1 ? '' : 's'} still to complete before the project can be sent for ${client}'s review.`;
  }

  const modalBody = completionModalBody(total, client);

  return {
    hasMilestones,
    milestonesRemaining: remaining,
    milestonesTotal: total,
    canRequest,
    bodyCopy,
    modalBody,
    ctaLabel: crState.latest === null ? 'Mark project ready' : MARK_READY_AGAIN_LABEL,
  };
}

/**
 * Map the hydrated engagement + resolved viewer context into the single
 * serializable workspace view. SERVER-ONLY (value-imports `AUTO_ACCEPT_DAYS` from
 * `@balo/db`) — the returned object is plain data safe to pass to any component.
 * `now` is injectable for deterministic tests (default `new Date()`). `changeOrders` are the
 * engagement's live change orders, oldest first: they move the terms strip to the effective
 * price, lock and badge milestones, and block the completion card while one is open.
 * `lastTimeLoggedAt` is when the latest live time entry was logged (T&M), a delivery signal for
 * the admin activity chip.
 */
export function mapEngagementToWorkspaceView(
  engagement: ProjectEngagementWithMilestones,
  ctx: EngagementViewerContext,
  now: Date = new Date(),
  changeOrders: readonly ChangeOrderWithLines[] = [],
  contentEdits: readonly MilestoneContentEditRow[] = [],
  lastTimeLoggedAt: Date | null = null
): EngagementWorkspaceView {
  const parties = deriveEngagementParties(engagement);
  const status = engagement.status;
  const engagementTitle = projectEngagementTitle(
    engagement.projectRequest?.title ?? null,
    parties.expertPartyShort
  );

  const provenance: ProvenanceLinkView | null =
    engagement.projectRequest === null
      ? null
      : {
          requestId: engagement.projectRequest.id,
          href: `/projects/${engagement.projectRequest.id}`,
        };

  const crState = deriveChangeRequestState(engagement, parties);
  const milestones = deriveMilestones(
    engagement,
    parties,
    ctx.lens,
    crState,
    changeOrders,
    contentEdits
  );

  const header: EngagementHeaderView = {
    engagementTitle,
    headerLine: engagementHeaderLine(ctx.lens, parties),
    statusChip: deriveStatusChip(status),
    provenance,
    terms: [
      ...deriveTermsStrip(engagement, ctx.lens, changeOrders),
      ...[deriveLastActivityChip(engagement, ctx.lens, parties, now, lastTimeLoggedAt)].filter(
        (item) => item !== null
      ),
    ],
    backHref: '/projects',
  };

  return {
    engagementId: engagement.id,
    lens: ctx.lens,
    archetype: ctx.archetype,
    status,
    isClientOwner: ctx.isClientOwner,
    isDeliveringExpert: ctx.isDeliveringExpert,
    header,
    parties,
    progress: deriveProgress(engagement, ctx.lens, parties, crState),
    milestones,
    hasMilestones: engagement.milestones.length > 0,
    reviewBanner: deriveReviewBanner(engagement, ctx.lens, parties, milestones),
    changeRequestBanner: deriveChangeRequestBanner(engagement, ctx.lens, parties, crState),
    completedBanner: deriveCompletedBanner(engagement, ctx.lens, parties),
    cancelledBanner: deriveCancelledBanner(engagement),
    emptyState: deriveEmptyState(engagement, ctx, parties),
    cancelDialog: deriveCancelDialog(engagement, parties),
    completionCard: deriveCompletionCard(engagement, ctx.lens, parties, crState, changeOrders),
    addMilestoneNeedsChangeOrder: engagement.pricingMethod === 'tm',
  };
}
