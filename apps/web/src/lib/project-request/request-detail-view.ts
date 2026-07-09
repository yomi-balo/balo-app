import type { ProjectRequestWithRelations } from '@balo/db';
import { formatBudgetRange } from '@/lib/utils/currency';
import type { RequestViewerContext, ProjectRequestStatus } from './resolve-request-lens';
import type { RelationshipStatus } from './conversation-view-types';

export interface RequestProductView {
  name: string;
}

export interface RequestTagView {
  name: string;
}

export interface RequestDocumentView {
  id: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

/** Derived per-expert display state for the admin pipeline-health panel. */
export type RelationshipState =
  | 'invited'
  | 'eoi_in'
  | 'proposal_requested'
  | 'proposal_in'
  | 'accepted'
  | 'declined';

/**
 * Kickoff-board projection — the dual-confirmation gate state once a request has
 * an accepted expert. `approved` is the terminal flag (both sides confirmed +
 * status advanced to `kickoff_approved`).
 */
export interface KickoffView {
  acceptedRelationshipId: string;
  clientBillingConfirmed: boolean;
  expertTermsConfirmed: boolean;
  approved: boolean;
  expertName: string;
}

/** Observer-only relationship projection (admin health panel). */
export interface RequestRelationshipView {
  id: string;
  expertName: string;
  /** Raw relationship status (kept for callers that key off the enum). */
  status: string;
  /** Derived display state for the panel. */
  state: RelationshipState;
  /** True when invited + no engagement for >= QUIET_THRESHOLD_DAYS. */
  isQuiet: boolean;
  /** Whole days since last activity (for the "Quiet N days" pill copy). */
  quietDays: number;
  /** Whether the remove control may show for this row (status === 'invited'). */
  removable: boolean;
}

export interface RequestDetailView {
  id: string;
  title: string;
  descriptionHtml: string;
  products: RequestProductView[];
  tags: RequestTagView[];
  documents: RequestDocumentView[];
  companyName: string;
  /** Named contact — `null` when contact gating drops it (never serialised). */
  contact: { name: string } | null;
  /** "3 days ago" — derived from createdAt. */
  postedRelative: string;
  status: ProjectRequestStatus;
  /** Pre-formatted budget range, or `null` when no budget was captured. */
  budget: string | null;
  /**
   * The request's Balo fee, in basis points — populated ONLY for the observer
   * (admin) lens; `null` for client/expert. The audience boundary (BAL-357): the
   * raw request fee must never cross into a non-admin payload, so it is nulled here
   * in the mapper rather than gated downstream.
   */
  baloFeeBps: number | null;
  /** Free-text timeline, or `null`. */
  timeline: string | null;
  /** Live relationships — populated ONLY for the observer (admin) lens. */
  relationships: RequestRelationshipView[];
  /**
   * The viewer-expert's OWN EOI state — populated ONLY for the expert lens (`null`
   * for client/admin). `messageHtml` is the viewer's own sanitised-HTML pitch (so
   * the EOI-entry island can re-render the submitted state); never another
   * expert's EOI crosses the boundary (gated on the viewer's relationship).
   */
  viewerEoi: { hasLiveEoi: boolean; messageHtml: string | null } | null;
  /**
   * The viewer-expert's OWN relationship status — populated ONLY for the expert
   * lens (`null` for client/admin). BAL-272 makes relationship statuses diverge
   * across threads, so the expert-facing derivers (page nudge, `ProposalSlot`)
   * must key on THIS, not the max-progress request status.
   */
  viewerRelationshipStatus: RelationshipStatus | null;
  /**
   * Kickoff-board gate state — populated for the client + admin lenses when the
   * request is at `accepted`/`kickoff_approved` and an accepted relationship
   * exists; for the expert lens ONLY when the viewer IS the accepted/winning
   * expert (a losing expert never sees the board). `null` otherwise.
   */
  kickoff: KickoffView | null;
}

const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * Days an `invited` expert may stay silent before the panel flags them "going
 * quiet". 3 days sits inside a typical 1-business-day review SLA — long enough to
 * not nag, short enough to surface a stall. Named const, never a magic number.
 * (Product decision — tunable; flag to reviewer.)
 */
export const QUIET_THRESHOLD_DAYS = 3;

/** Raw relationship status → derived panel display state. */
const RELATIONSHIP_STATE_MAP: Record<string, RelationshipState> = {
  invited: 'invited',
  eoi_submitted: 'eoi_in',
  proposal_requested: 'proposal_requested',
  proposal_submitted: 'proposal_in',
  accepted: 'accepted',
  declined: 'declined',
};

/**
 * Coarse relative "posted" label. Whole-day granularity is enough for a brief
 * ("Posted 3 days ago"); we never show sub-day precision here.
 */
export function formatPostedRelative(createdAt: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - createdAt.getTime();
  const days = Math.floor(diffMs / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

function contactName(createdByUser: ProjectRequestWithRelations['createdByUser']): string {
  const full = [createdByUser.firstName, createdByUser.lastName].filter(Boolean).join(' ').trim();
  if (full.length > 0) return full;
  // Fallback to the email local-part — never the full address.
  const localPart = createdByUser.email.split('@')[0];
  return localPart && localPart.length > 0 ? localPart : 'Client contact';
}

function relationshipName(
  relationship: ProjectRequestWithRelations['relationships'][number]
): string {
  const { user } = relationship.expertProfile;
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full.length > 0 ? full : 'Invited expert';
}

/**
 * Last-activity timestamp for a relationship: the most recent of its invite, its
 * row's last update, its newest live EOI, and its newest live message. Each child
 * collection is `limit:1` newest-first (see `findByIdWithRelations`).
 */
function lastActivityAt(relationship: ProjectRequestWithRelations['relationships'][number]): Date {
  // `updatedAt`, plus the newest live EOI / message if present. `invitedAt` seeds
  // the reduce as its initial value, so the fold always has a base (no empty-array
  // reduce) and the result is the most-recent of invite / update / EOI / message.
  const candidates: Date[] = [relationship.updatedAt];

  const [latestEoi] = relationship.expressionsOfInterest;
  if (latestEoi !== undefined) candidates.push(latestEoi.submittedAt);

  const [latestMessage] = relationship.conversationMessages;
  if (latestMessage !== undefined) candidates.push(latestMessage.createdAt);

  return candidates.reduce(
    (max, d) => (d.getTime() > max.getTime() ? d : max),
    relationship.invitedAt
  );
}

/**
 * Pure per-expert deriver: raw relationship row → panel view-model. `now` is
 * injectable so the quiet-days math is deterministic in tests.
 */
function deriveRelationshipView(
  relationship: ProjectRequestWithRelations['relationships'][number],
  now: Date
): RequestRelationshipView {
  const state = RELATIONSHIP_STATE_MAP[relationship.status] ?? 'invited';
  const quietDays = Math.floor((now.getTime() - lastActivityAt(relationship).getTime()) / DAY_MS);
  const isQuiet = state === 'invited' && quietDays >= QUIET_THRESHOLD_DAYS;

  return {
    id: relationship.id,
    expertName: relationshipName(relationship),
    status: relationship.status,
    state,
    isQuiet,
    quietDays,
    removable: relationship.status === 'invited',
  };
}

/**
 * The viewer-expert's own EOI projection (expert lens only). Finds the viewer's
 * relationship by `ctx.relationshipId` and reads its newest live EOI (hydrated
 * `limit:1` newest-first). Returns `null` for any non-expert lens or when the
 * resolver produced no relationship id — so a client/admin payload never carries
 * EOI HTML. Pure + deterministic.
 */
function deriveViewerEoi(
  request: ProjectRequestWithRelations,
  ctx: RequestViewerContext
): { hasLiveEoi: boolean; messageHtml: string | null } | null {
  if (ctx.lens !== 'expert' || ctx.relationshipId === null) return null;
  const relationship = request.relationships.find((r) => r.id === ctx.relationshipId);
  const [eoi] = relationship?.expressionsOfInterest ?? [];
  return { hasLiveEoi: eoi !== undefined, messageHtml: eoi?.message ?? null };
}

/**
 * The viewer-expert's own relationship status (expert lens only — `null` for
 * client/admin, so a non-expert payload never carries another expert's state).
 * Pure + deterministic; mirrors {@link deriveViewerEoi}.
 */
function deriveViewerRelationshipStatus(
  request: ProjectRequestWithRelations,
  ctx: RequestViewerContext
): RelationshipStatus | null {
  if (ctx.lens !== 'expert' || ctx.relationshipId === null) return null;
  const relationship = request.relationships.find((r) => r.id === ctx.relationshipId);
  return relationship?.status ?? null;
}

/**
 * Kickoff-board projection — the dual-confirmation gate state. Returns `null`
 * unless the request is at `accepted`/`kickoff_approved` AND has an accepted
 * relationship (it stays `accepted` even after `kickoff_approved` — there is no
 * `kickoff_approved` relationship status). The expert lens is gated to the
 * accepted/winning expert only (a losing expert never sees the board); client +
 * admin are never gated here. Pure + deterministic.
 */
function deriveKickoffView(
  request: ProjectRequestWithRelations,
  ctx: RequestViewerContext
): KickoffView | null {
  if (request.status !== 'accepted' && request.status !== 'kickoff_approved') return null;
  const accepted = request.relationships.find((r) => r.status === 'accepted');
  if (accepted === undefined) return null;
  // Only the winning expert sees the board; client + admin are never gated here.
  if (ctx.lens === 'expert' && ctx.relationshipId !== accepted.id) return null;
  return {
    acceptedRelationshipId: accepted.id,
    clientBillingConfirmed: request.clientBillingConfirmedAt !== null,
    expertTermsConfirmed: request.expertTermsConfirmedAt !== null,
    approved: request.status === 'kickoff_approved',
    expertName: relationshipName(accepted),
  };
}

/**
 * Pure mapper: hydrated DB graph → fully serializable view-model the leaf
 * components consume. Mirrors `mapProfileToView`.
 *
 * THE SERVER-SIDE CONTACT-GATING ENFORCEMENT POINT: when `ctx.canSeeContact` is
 * false, `contact` is `null` and the contact's name is NEVER placed into the
 * payload — so it cannot cross the RSC boundary (no CSS-hidden DOM node carries
 * it). The observer-only `relationships` projection is populated for admins only.
 */
export function mapRequestToDetailView(
  request: ProjectRequestWithRelations,
  ctx: RequestViewerContext,
  now: Date = new Date()
): RequestDetailView {
  return {
    id: request.id,
    title: request.title,
    descriptionHtml: request.description,
    products: request.products.map((p) => ({ name: p.product.name })),
    tags: request.tags.map((t) => ({ name: t.projectTag.name })),
    documents: request.documents.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      sizeBytes: d.sizeBytes,
      contentType: d.contentType,
    })),
    companyName: request.company.name,
    contact: ctx.canSeeContact ? { name: contactName(request.createdByUser) } : null,
    postedRelative: formatPostedRelative(request.createdAt, now),
    status: request.status,
    budget: formatBudgetRange(
      request.budgetMinCents,
      request.budgetMaxCents,
      request.budgetCurrency
    ),
    // Audience boundary: only the observer (admin) lens carries the raw fee.
    baloFeeBps: ctx.archetype === 'observer' ? request.baloFeeBps : null,
    timeline: request.timeline,
    relationships:
      ctx.archetype === 'observer'
        ? request.relationships.map((r) => deriveRelationshipView(r, now))
        : [],
    viewerEoi: deriveViewerEoi(request, ctx),
    viewerRelationshipStatus: deriveViewerRelationshipStatus(request, ctx),
    kickoff: deriveKickoffView(request, ctx),
  };
}
