import 'server-only';

import { AUTO_ACCEPT_DAYS, type EngagementWithMilestones } from '@balo/db';
import { applyBaloFee } from '@balo/shared/pricing';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
// The single-source "start a new project" front door (BAL-274). Currently expert
// discovery; when BAL-253's generic match front door lands, that ONE constant repoints
// and this completed-banner CTA follows with no change here.
import { NEW_REQUEST_HREF } from '@/app/(dashboard)/projects/_components/constants';
import {
  deriveEngagementParties,
  engagementHeaderLine,
  personAtCompany,
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

/** Web-side stall threshold (D0's `QUIET_THRESHOLD_DAYS` is a comment, not exported). */
export const DELIVERY_QUIET_THRESHOLD_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type EngagementWorkspaceStatus = 'active' | 'pending_acceptance' | 'completed' | 'cancelled';

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
  | 'Flag';

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

export interface EngagementProgressView {
  done: number;
  total: number;
  /** 0..100, rounded. */
  pct: number;
  /** Client-lens whole-project review explainer; null for expert/admin. */
  reviewCopy: string | null;
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
}

export interface CountdownView {
  /** Formatted auto-accept date, e.g. "11 Jul 2026". */
  autoOnDate: string;
  /** Whole days remaining, clamped >= 0 (informational — no action in D1). */
  daysRemaining: number;
  /** Full pill label, e.g. "Auto-accepts in 5 days" / "Auto-accepts in 1 day" / "Auto-accepts today". */
  autoInLabel: string;
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
}

export interface ReviewBannerView {
  title: string;
  body: string;
  /** Null only if the request timestamp is somehow absent (guarded). */
  countdown: CountdownView | null;
  /** Client-lens only: the accept / request-changes decision copy; null for expert/admin. */
  clientDecision: ReviewClientDecisionView | null;
}

export interface ChangeRequestBannerView {
  /** `personAtCompany(changeRequestedBy)`, e.g. "Dana @ Northwind Industrial". */
  attribution: string;
  note: string;
  /** Expert-lens trailing nudge; null for admin. */
  expertNudge: string | null;
}

/**
 * BAL-338 (D7) — the client's next-step CTAs on the completed banner. v1 ships only
 * affordances whose destinations already exist (new request → the discovery front
 * door; Message → the source request's conversation). The v2 marketplace hooks
 * (review-request, rehire shortcut) slot into this same row. Non-null ONLY on the
 * client lens.
 */
export interface CompletedBannerClientCtaView {
  /** "Start your next project" — the discovery/new-request front door. */
  nextProjectHref: string;
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

export interface AdminOversightView {
  /** "Last delivery activity: 2d ago". */
  lastActivityLabel: string;
  stalled: boolean;
  /** Contextual nudge when stalled; null otherwise. */
  stalledNote: string | null;
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
  adminOversight: AdminOversightView | null;
  /** Expert-lens + active only: the "Finish the project" card (D4); null otherwise. */
  completionCard: CompletionCardView | null;
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

/**
 * The full auto-accept pill label. The final day (0 days remaining) reads
 * "Auto-accepts today" — never the awkward "Auto-accepts in 0 days"; every other
 * value keeps the singular/plural "Auto-accepts in N day(s)".
 */
function autoAcceptPillLabel(daysRemaining: number): string {
  if (daysRemaining === 0) return 'Auto-accepts today';
  return `Auto-accepts in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;
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

function pricingLabel(pricingMethod: EngagementWithMilestones['pricingMethod']): string {
  return pricingMethod === 'fixed' ? 'Fixed price' : 'Time & materials';
}

function cadenceLabel(cadence: NonNullable<EngagementWithMilestones['cadence']>): string {
  return cadence === 'monthly' ? 'Monthly retainer' : 'Fortnightly retainer';
}

/**
 * Terms-strip "timeframe" is derived honestly (the proposal's "~10 weeks" is NOT
 * snapshotted, so it is not reproducible): a retainer cadence humanises to
 * "Monthly retainer"; otherwise Σ live-milestone `estimatedMinutes` → "~Nh
 * estimated"; otherwise the pill is OMITTED (the strip tolerates optional pills).
 */
function deriveTimeframeItem(engagement: EngagementWithMilestones): TermsStripItem | null {
  if (engagement.cadence !== null) {
    return { icon: 'Clock', label: 'Timeframe', value: cadenceLabel(engagement.cadence) };
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
  engagement: EngagementWithMilestones,
  lens: EngagementLens
): TermsStripItem[] {
  // Client sees the marked-up (grossed-up) figure, derived on read from the
  // snapshotted `baloFeeBps`; expert & admin see the RAW payout quote (`priceCents`).
  const priceCents =
    lens === 'client'
      ? applyBaloFee(engagement.priceCents, engagement.baloFeeBps)
      : engagement.priceCents;
  const items: TermsStripItem[] = [
    {
      icon: 'DollarSign',
      label: 'Pricing',
      value: `${pricingLabel(engagement.pricingMethod)} · ${formatWholeCurrency(
        priceCents,
        engagement.currency
      )}`,
    },
  ];
  const timeframe = deriveTimeframeItem(engagement);
  if (timeframe !== null) items.push(timeframe);

  const kickedOffAt = engagement.activatedAt ?? engagement.createdAt;
  items.push({
    icon: 'CalendarDays',
    label: 'Kicked off',
    value: `Kicked off ${formatShortDate(kickedOffAt)}`,
  });
  return items;
}

function deriveMilestones(
  engagement: EngagementWithMilestones,
  parties: EngagementParties,
  lens: EngagementLens
): MilestoneNodeView[] {
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
    const valueLabel =
      rawValue !== null && rawValue > 0
        ? formatWholeCurrency(
            lens === 'client' ? applyBaloFee(rawValue, engagement.baloFeeBps) : rawValue,
            engagement.currency
          )
        : null;
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
    };
  });
}

function deriveProgress(
  engagement: EngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties
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
    lens === 'client' && isNonTerminal
      ? `${parties.expertPartyShort} marks each milestone as it's delivered. When the whole project is done, you review it — accept, or request changes within ${AUTO_ACCEPT_DAYS} days.`
      : null;
  return { done, total, pct, reviewCopy };
}

function deriveReviewBanner(
  engagement: EngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties,
  now: Date
): ReviewBannerView | null {
  if (engagement.status !== 'pending_acceptance') return null;

  const requestedAt = engagement.completionRequestedAt;
  let countdown: CountdownView | null = null;
  let autoOnLabel = 'the review deadline';
  let requestedAtLabel = 'recently';
  if (requestedAt !== null) {
    const autoOn = new Date(requestedAt.getTime() + AUTO_ACCEPT_DAYS * DAY_MS);
    const daysRemaining = Math.max(0, Math.ceil((autoOn.getTime() - now.getTime()) / DAY_MS));
    autoOnLabel = formatLongDate(autoOn);
    requestedAtLabel = formatShortDate(requestedAt);
    countdown = {
      autoOnDate: autoOnLabel,
      daysRemaining,
      autoInLabel: autoAcceptPillLabel(daysRemaining),
    };
  }

  if (lens === 'client') {
    const expertShort = parties.expertPersonShort;
    return {
      title: `${parties.expertRetroFirstMention} has marked the project complete`,
      body: `Review the delivery plan below, then accept the project or request changes. If no one responds, the project is accepted automatically on ${autoOnLabel} so delivery isn't left hanging.`,
      countdown,
      clientDecision: {
        acceptModalBody: `Accepting confirms ${expertShort} delivered the project as agreed — it can't be un-accepted afterwards, and Balo raises the final invoice from here. If something's not right, request changes instead. ${expertShort} and the Balo team are notified.`,
        requestChangesIntro: `The project goes back to active with your note attached — ${expertShort} and the Balo team are notified, and the project is marked complete again once it's fixed. The ${AUTO_ACCEPT_DAYS}-day review window restarts then.`,
        requestChangesFieldHint: `Be specific — this is exactly what ${expertShort} sees.`,
      },
    };
  }
  if (lens === 'expert') {
    return {
      title: `Completion requested — awaiting ${parties.clientCompanyName}'s review`,
      body: `Requested ${requestedAtLabel}. ${parties.clientCompanyName} has ${AUTO_ACCEPT_DAYS} days to accept or request changes — after that the project is accepted automatically. The delivery plan is locked while the project is in review.`,
      countdown,
      clientDecision: null,
    };
  }
  return {
    title: `Completion requested — awaiting ${parties.clientCompanyName}'s review`,
    body: `Requested ${requestedAtLabel} by ${parties.expertRetroFirstMention}. Auto-accepts ${autoOnLabel} unless ${parties.clientCompanyName} responds. Final invoice raises once accepted.`,
    countdown,
    clientDecision: null,
  };
}

function deriveChangeRequestBanner(
  engagement: EngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties
): ChangeRequestBannerView | null {
  // Client already knows they requested changes → null for the client lens.
  if (lens === 'client') return null;
  if (engagement.status !== 'active') return null;
  const note = engagement.changeRequestNote;
  if (note === null || note.trim() === '') return null;
  return {
    attribution: personAtCompany(engagement.changeRequestedBy, parties.clientCompanyName),
    note,
    expertNudge:
      lens === 'expert' ? '— fix it up and mark the project complete again when ready.' : null,
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
  engagement: EngagementWithMilestones,
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
        nextProjectHref: NEW_REQUEST_HREF,
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

function deriveCancelledBanner(engagement: EngagementWithMilestones): CancelledBannerView | null {
  if (engagement.status !== 'cancelled') return null;
  const cancelledAtLabel =
    engagement.cancelledAt === null ? 'an earlier date' : formatLongDate(engagement.cancelledAt);
  const reason =
    engagement.cancellationReason !== null && engagement.cancellationReason.trim() !== ''
      ? engagement.cancellationReason
      : null;
  return {
    title: 'Engagement cancelled',
    body: `Cancelled by Balo on ${cancelledAtLabel}.`,
    reason,
  };
}

function deriveEmptyState(
  engagement: EngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties
): EmptyStateView | null {
  if (engagement.milestones.length > 0) return null;
  // Terminal engagements show only their completed/cancelled banner — a
  // forward-looking "shaping the delivery plan" invitation would be stale.
  if (engagement.status === 'completed' || engagement.status === 'cancelled') return null;
  if (lens === 'expert') {
    return {
      icon: 'Flag',
      title: 'Shape the delivery plan',
      body: `Add your first milestone so ${parties.clientCompanyName} can follow progress. When everything is delivered, you mark the project complete and ${parties.clientCompanyName} reviews it as a whole.`,
    };
  }
  if (lens === 'client') {
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

/** Latest delivery-signal timestamp: milestone starts / completions, activation, request. */
function deriveLastActivityAt(engagement: EngagementWithMilestones): Date {
  // `createdAt` always exists, so it seeds the fold — the reduce can never run on
  // an empty array (S6959) while still yielding the max of every delivery signal.
  const candidates: Date[] = [];
  if (engagement.activatedAt !== null) candidates.push(engagement.activatedAt);
  if (engagement.completionRequestedAt !== null) candidates.push(engagement.completionRequestedAt);
  for (const m of engagement.milestones) {
    if (m.startedAt !== null) candidates.push(m.startedAt);
    if (m.completedAt !== null) candidates.push(m.completedAt);
  }
  return candidates.reduce(
    (latest, d) => (d.getTime() > latest.getTime() ? d : latest),
    engagement.createdAt
  );
}

function deriveAdminOversight(
  engagement: EngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties,
  now: Date
): AdminOversightView | null {
  if (lens !== 'admin') return null;
  if (engagement.status !== 'active' && engagement.status !== 'pending_acceptance') return null;
  const lastActivityAt = deriveLastActivityAt(engagement);
  const stalled = wholeDaysSince(lastActivityAt, now) >= DELIVERY_QUIET_THRESHOLD_DAYS;
  return {
    lastActivityLabel: `Last delivery activity: ${formatRelativeDays(lastActivityAt, now)}`,
    stalled,
    stalledNote: stalled
      ? `Nothing has moved for a while — worth a check-in with ${parties.expertPartyShort} before ${parties.clientCompanyName} asks.`
      : null,
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
  engagement: EngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties
): CompletionCardView | null {
  if (lens !== 'expert') return null;
  if (engagement.status !== 'active') return null;

  const total = engagement.milestones.length;
  const done = engagement.milestones.filter((m) => m.status === 'completed').length;
  const remaining = Math.max(0, total - done);
  const hasMilestones = total > 0;
  const allDone = remaining === 0;
  const canRequest = total === 0 || allDone;
  const client = parties.clientCompanyName;

  let bodyCopy: string;
  if (total === 0) {
    bodyCopy = `This project has no milestones — you can still send it for ${client}'s review, but a visible plan builds trust.`;
  } else if (allDone) {
    bodyCopy = `Every milestone is delivered. Marking complete sends the project to ${client} for review — ${client} can accept or request changes within ${AUTO_ACCEPT_DAYS} days, after which it's accepted automatically.`;
  } else {
    bodyCopy = `${remaining} of ${total} milestone${total === 1 ? '' : 's'} still to complete before the project can be sent for ${client}'s review.`;
  }

  let modalOpening: string;
  if (total === 0) {
    modalOpening =
      "This project has no milestones, so there's nothing blocking completion — but only send it if delivery is genuinely done. ";
  } else if (total === 1) {
    modalOpening = 'The milestone is delivered. ';
  } else {
    modalOpening = `All ${total} milestones are delivered. `;
  }
  const modalBody = `${modalOpening}${client} reviews the whole project and can accept it or request changes within ${AUTO_ACCEPT_DAYS} days — after that it's accepted automatically. The delivery plan is locked while the project is in review, and Balo raises the final invoice once accepted.`;

  return {
    hasMilestones,
    milestonesRemaining: remaining,
    milestonesTotal: total,
    canRequest,
    bodyCopy,
    modalBody,
  };
}

/**
 * Map the hydrated engagement + resolved viewer context into the single
 * serializable workspace view. SERVER-ONLY (value-imports `AUTO_ACCEPT_DAYS` from
 * `@balo/db`) — the returned object is plain data safe to pass to any component.
 * `now` is injectable for deterministic tests (default `new Date()`).
 */
export function mapEngagementToWorkspaceView(
  engagement: EngagementWithMilestones,
  ctx: EngagementViewerContext,
  now: Date = new Date()
): EngagementWorkspaceView {
  const parties = deriveEngagementParties(engagement);
  const status = engagement.status;
  const engagementTitle =
    engagement.projectRequest !== null &&
    engagement.projectRequest.title !== null &&
    engagement.projectRequest.title.trim() !== ''
      ? engagement.projectRequest.title
      : `Delivery with ${parties.expertPartyShort}`;

  const provenance: ProvenanceLinkView | null =
    engagement.projectRequest === null
      ? null
      : {
          requestId: engagement.projectRequest.id,
          href: `/projects/${engagement.projectRequest.id}`,
        };

  const header: EngagementHeaderView = {
    engagementTitle,
    headerLine: engagementHeaderLine(ctx.lens, parties),
    statusChip: deriveStatusChip(status),
    provenance,
    terms: deriveTermsStrip(engagement, ctx.lens),
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
    progress: deriveProgress(engagement, ctx.lens, parties),
    milestones: deriveMilestones(engagement, parties, ctx.lens),
    hasMilestones: engagement.milestones.length > 0,
    reviewBanner: deriveReviewBanner(engagement, ctx.lens, parties, now),
    changeRequestBanner: deriveChangeRequestBanner(engagement, ctx.lens, parties),
    completedBanner: deriveCompletedBanner(engagement, ctx.lens, parties),
    cancelledBanner: deriveCancelledBanner(engagement),
    emptyState: deriveEmptyState(engagement, ctx.lens, parties),
    adminOversight: deriveAdminOversight(engagement, ctx.lens, parties, now),
    completionCard: deriveCompletionCard(engagement, ctx.lens, parties),
  };
}
