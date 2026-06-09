import type { ProjectRequestWithRelations } from '@balo/db';
import { formatBudgetRange } from '@/lib/utils/currency';
import type { RequestViewerContext, ProjectRequestStatus } from './resolve-request-lens';

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

/** Observer-only relationship projection (admin health panel). */
export interface RequestRelationshipView {
  id: string;
  expertName: string;
  status: string;
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
  /** Free-text timeline, or `null`. */
  timeline: string | null;
  /** Live relationships — populated ONLY for the observer (admin) lens. */
  relationships: RequestRelationshipView[];
}

const DAY_MS = 1000 * 60 * 60 * 24;

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
    timeline: request.timeline,
    relationships:
      ctx.archetype === 'observer'
        ? request.relationships.map((r) => ({
            id: r.id,
            expertName: relationshipName(r),
            status: r.status,
          }))
        : [],
  };
}
