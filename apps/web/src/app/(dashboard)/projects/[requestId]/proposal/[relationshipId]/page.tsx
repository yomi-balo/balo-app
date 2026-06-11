import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import {
  projectRequestsRepository,
  proposalsRepository,
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
  proposalDocumentsRepository,
  type Proposal,
  type ProposalMilestone,
  type ProposalPaymentInstallment,
  type ProposalDocument,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import { ProposalComposer } from '@/components/balo/project-request/proposal/proposal-composer';
import {
  emptyDraftState,
  nextDraftKey,
  seedInstallments,
  type ProposalDraftState,
} from '@/components/balo/project-request/proposal/proposal-composer-state';
import { ProposalReview } from '@/components/balo/project-request/proposal/proposal-review';
import { SubmittedView } from '@/components/balo/project-request/proposal/submitted-view';
import type { ProposalReviewDoc } from '@/components/balo/project-request/proposal/proposal-review-types';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';

interface ProposalComposerPageProps {
  params: Promise<{ requestId: string; relationshipId: string }>;
}

type Relationship = ProjectRequestWithRelations['relationships'][number];

/** Relationship statuses at which a proposal has been submitted and is reviewable. */
const SUBMITTED_RELATIONSHIP_STATUSES = new Set<Relationship['status']>([
  'proposal_submitted',
  'accepted',
]);

/** Proposal statuses a client may see in the review surface (live, decided, or in-flight). */
const REVIEWABLE_PROPOSAL_STATUSES = new Set<Proposal['status']>([
  'submitted',
  'changes_requested',
  'accepted',
]);

// Private dashboard surface — never indexed. A neutral title (no "Build
// proposal") so the review/submitted lenses don't leak the composer framing;
// the composer branch keeps its own framing in the page body, not the <title>.
export const metadata: Metadata = {
  title: 'Proposal — Balo',
  robots: { index: false, follow: false },
};

function firstNameOf(firstName: string | null, fallback: string): string {
  const trimmed = (firstName ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Full display name from first/last, or the given fallback when both are blank. */
function fullNameOf(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback: string
): string {
  const full = [firstName, lastName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ');
  return full.length > 0 ? full : fallback;
}

/** 1-2 char avatar fallback from first/last initials, or 'EX' when both blank. */
function initialsOf(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): string {
  const initials = [firstName, lastName]
    .map((part) => (part ?? '').trim().charAt(0).toUpperCase())
    .filter((char) => char.length > 0)
    .join('');
  return initials.length > 0 ? initials : 'EX';
}

function documentToView(document: ProposalDocument): ProposalDocumentView {
  return {
    id: document.id,
    proposalId: document.proposalId,
    kind: document.kind,
    fileName: document.fileName,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
    uploadedByUserId: document.uploadedByUserId,
    createdAtIso: document.createdAt.toISOString(),
  };
}

/**
 * Build a fully-hydrated initial `ProposalDraftState` from the persisted draft +
 * its children + documents. The composer never fetches on mount — everything it
 * needs is serialised here. A relationship with no draft yet starts empty (the
 * first autosave creates it).
 */
function hydrateDraftState(
  draft: Proposal | undefined,
  milestones: ProposalMilestone[],
  installments: ProposalPaymentInstallment[],
  documents: ProposalDocument[]
): ProposalDraftState {
  if (draft === undefined) {
    return emptyDraftState();
  }

  const isFixed = draft.pricingMethod === 'fixed';
  const hydratedMilestones =
    milestones.length > 0
      ? milestones.map((m) => ({
          key: nextDraftKey(),
          title: m.title,
          descriptionHtml: m.descriptionHtml ?? '',
          acceptanceCriteria: m.acceptanceCriteria ?? '',
          valueCents: m.valueCents,
        }))
      : emptyDraftState().milestones;

  const hydratedInstallments =
    installments.length > 0
      ? installments.map((i) => ({ key: nextDraftKey(), label: i.label, pct: i.pct }))
      : seedInstallments();

  return {
    proposalId: draft.id,
    overview: draft.overview,
    pricingMethod: draft.pricingMethod,
    currency: draft.currency,
    timeframeWeeks: draft.timeframeWeeks,
    exclusions: draft.exclusions ?? '',
    depositCents: draft.depositCents,
    rateCents: draft.rateCents,
    cadence: draft.cadence ?? 'monthly',
    milestones: hydratedMilestones,
    installments: isFixed ? hydratedInstallments : [],
    documents: documents.map(documentToView),
  };
}

/**
 * Map a persisted proposal (+ its children) into the serialisable, presentation-
 * only {@link ProposalReviewDoc} the read/submitted views render. Money stays in
 * integer cents; no dates cross the boundary (the review shows none).
 *
 * Expert identity is derived from the only fields `findByIdWithRelations`
 * hydrates on each relationship: `expertProfile.user.{firstName,lastName}`.
 * `company`, `headline`, and `rating` are NOT on that graph, so they degrade to
 * `null` — the read components hide those rows when null (no invented fields).
 */
function hydrateReviewDoc(
  proposal: Proposal,
  milestones: ProposalMilestone[],
  installments: ProposalPaymentInstallment[],
  documents: ProposalDocument[],
  relationship: Relationship
): ProposalReviewDoc {
  const expertUser = relationship.expertProfile.user;
  return {
    id: proposal.id,
    relationshipId: proposal.relationshipId,
    version: proposal.version,
    status: proposal.status,
    pricingMethod: proposal.pricingMethod,
    overviewHtml: proposal.overview,
    exclusionsHtml: proposal.exclusions,
    priceCents: proposal.priceCents,
    currency: proposal.currency,
    timeframeWeeks: proposal.timeframeWeeks,
    depositCents: proposal.depositCents,
    rateCents: proposal.rateCents,
    cadence: proposal.cadence,
    milestones: milestones.map((m) => ({
      id: m.id,
      title: m.title,
      descriptionHtml: m.descriptionHtml,
      acceptanceCriteria: m.acceptanceCriteria,
      valueCents: m.valueCents,
    })),
    installments: installments.map((i) => ({ id: i.id, label: i.label, pct: i.pct })),
    attachments: documents.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      sizeBytes: d.sizeBytes,
      kind: d.kind,
    })),
    expert: {
      name: fullNameOf(expertUser.firstName, expertUser.lastName, 'Your expert'),
      initials: initialsOf(expertUser.firstName, expertUser.lastName),
      // Not hydrated by `findByIdWithRelations` — degrade gracefully (the read
      // components omit these rows when null). Do NOT invent fields.
      company: null,
      headline: null,
      rating: null,
    },
  };
}

/**
 * Load a relationship's current proposal (+ children, in parallel) and hydrate it
 * into a {@link ProposalReviewDoc}. Returns `null` when the relationship has no
 * current proposal, or its status isn't reviewable (e.g. `draft`/`withdrawn`).
 */
async function loadReviewDoc(relationship: Relationship): Promise<ProposalReviewDoc | null> {
  const proposal = await proposalsRepository.findCurrentByRelationship(relationship.id);
  if (proposal === undefined || !REVIEWABLE_PROPOSAL_STATUSES.has(proposal.status)) {
    return null;
  }
  const [milestones, installments, documents] = await Promise.all([
    proposalMilestonesRepository.listByProposal(proposal.id),
    proposalPaymentInstallmentsRepository.listByProposal(proposal.id),
    proposalDocumentsRepository.listByProposal(proposal.id),
  ]);
  return hydrateReviewDoc(proposal, milestones, installments, documents, relationship);
}

/**
 * The EXPERT proposal composer surface (A6.2 / BAL-288), unchanged. Deep-linkable
 * from the A5 "Build your proposal →" email; only the expert on THIS relationship,
 * at `proposal_requested`, reaches here (the dispatcher gates).
 */
async function renderComposer(
  requestId: string,
  relationshipId: string,
  request: ProjectRequestWithRelations
): Promise<React.JSX.Element> {
  // Load the current draft, then its children + documents in parallel.
  const draft = await proposalsRepository.findCurrentByRelationship(relationshipId);
  const [milestones, installments, documents] =
    draft === undefined
      ? [[], [], []]
      : await Promise.all([
          proposalMilestonesRepository.listByProposal(draft.id),
          proposalPaymentInstallmentsRepository.listByProposal(draft.id),
          proposalDocumentsRepository.listByProposal(draft.id),
        ]);

  const initialState = hydrateDraftState(draft, milestones, installments, documents);
  const clientFirstName = firstNameOf(request.createdByUser.firstName, 'the client');

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5">
        <Link
          href={`/projects/${requestId}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to {request.title}
        </Link>
        <h1 className="text-foreground mt-3 text-2xl font-semibold">Build your proposal</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Draft your scope, milestones, and pricing for {clientFirstName}. Everything saves as you
          go.
        </p>
      </div>

      <ProposalComposer
        requestId={requestId}
        relationshipId={relationshipId}
        clientFirstName={clientFirstName}
        initialState={initialState}
      />
    </div>
  );
}

/** Shared back link + page chrome for the read (review / submitted) lenses. */
function ReviewShell({
  requestId,
  title,
  children,
}: Readonly<{
  requestId: string;
  title: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5">
        <Link
          href={`/projects/${requestId}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to {title}
        </Link>
      </div>
      {children}
    </div>
  );
}

/**
 * Count OTHER relationships on the request (≠ `selfId`) whose current proposal is
 * live/decided (submitted or accepted relationship status) — the "alongside N
 * others" framing for the submitted view.
 */
function otherSubmittedCount(request: ProjectRequestWithRelations, selfId: string): number {
  return request.relationships.filter(
    (r) => r.id !== selfId && SUBMITTED_RELATIONSHIP_STATUSES.has(r.status)
  ).length;
}

/**
 * The proposal surface (A6.2 / BAL-288 composer + A6.4 / BAL-289 review/submitted).
 * After loading `request` + `resolveRequestLens` + the URL relationship, dispatches
 * by lens × status:
 *  - expert, own relationship, `proposal_requested` → the composer (unchanged).
 *  - expert, own relationship, submitted/accepted → the read-only SubmittedView.
 *  - client (owns the request), submitted/accepted/changes_requested → ProposalReview
 *    (switcher across every reviewable proposal on the request).
 *  - admin (observer), submitted/accepted → SubmittedView (admin framing).
 *  - anything else → redirect to the request detail (no existence leak).
 */
export default async function ProposalComposerPage({
  params,
}: Readonly<ProposalComposerPageProps>): Promise<React.JSX.Element> {
  const { requestId, relationshipId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let request: Awaited<ReturnType<typeof projectRequestsRepository.findByIdWithRelations>>;
  try {
    request = await projectRequestsRepository.findByIdWithRelations(requestId);
  } catch (error) {
    log.error('Failed to load request for proposal surface', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  if (!request) {
    notFound();
  }

  const ctx = resolveRequestLens(user, request);
  if (ctx === null) {
    // Unauthorised — same redirect as every other branch (no existence leak).
    redirect(`/projects/${requestId}`);
  }

  const relationship = request.relationships.find((r) => r.id === relationshipId);
  if (relationship === undefined) {
    redirect(`/projects/${requestId}`);
  }

  const clientFirstName = firstNameOf(request.createdByUser.firstName, 'the client');

  // ── Expert lens — only their OWN relationship ─────────────────────────────
  if (ctx.lens === 'expert' && ctx.relationshipId === relationshipId) {
    // Composer: the draft surface while the client is awaiting a proposal.
    if (relationship.status === 'proposal_requested') {
      return renderComposer(requestId, relationshipId, request);
    }
    // Submitted view: read-only "awaiting the client" once a proposal exists.
    if (SUBMITTED_RELATIONSHIP_STATUSES.has(relationship.status)) {
      const doc = await loadReviewDoc(relationship);
      if (doc !== null) {
        return (
          <ReviewShell requestId={requestId} title={request.title}>
            <SubmittedView
              lens="expert"
              doc={doc}
              clientName={clientFirstName}
              otherProposalCount={otherSubmittedCount(request, relationshipId)}
            />
          </ReviewShell>
        );
      }
    }
    // No matching expert surface — fall through to the shared deny + redirect.
  }

  // ── Client lens — owns the request ────────────────────────────────────────
  // NOTE: `changes_requested` is a *proposal* status, not a *relationship*
  // status — the relationship stays at `proposal_submitted` while the expert
  // revises. `loadReviewDoc` admits a `changes_requested` proposal, and
  // `ProposalReview` renders its "awaiting revision" empty state.
  if (ctx.lens === 'client' && SUBMITTED_RELATIONSHIP_STATUSES.has(relationship.status)) {
    // Every reviewable proposal on the request powers the switcher.
    const docs = await Promise.all(request.relationships.map((r) => loadReviewDoc(r)));
    const reviewableDocs = docs.filter((d): d is ProposalReviewDoc => d !== null);
    if (reviewableDocs.length > 0) {
      return (
        <ReviewShell requestId={requestId} title={request.title}>
          <ProposalReview
            requestId={requestId}
            proposals={reviewableDocs}
            activeRelationshipId={relationshipId}
            clientCompanyName={request.company?.name ?? 'your company'}
            clientFirstName={clientFirstName}
          />
        </ReviewShell>
      );
    }
  }

  // ── Admin lens — observer ─────────────────────────────────────────────────
  if (ctx.lens === 'admin' && SUBMITTED_RELATIONSHIP_STATUSES.has(relationship.status)) {
    const doc = await loadReviewDoc(relationship);
    if (doc !== null) {
      return (
        <ReviewShell requestId={requestId} title={request.title}>
          <SubmittedView
            lens="admin"
            doc={doc}
            clientName={clientFirstName}
            otherProposalCount={otherSubmittedCount(request, relationshipId)}
          />
        </ReviewShell>
      );
    }
  }

  // Anything else — wrong lens/status, or no reviewable proposal.
  log.warn('Proposal surface access denied', {
    requestId,
    relationshipId,
    userId: user.id,
    lens: ctx.lens,
    relationshipStatus: relationship.status,
  });
  redirect(`/projects/${requestId}`);
}
