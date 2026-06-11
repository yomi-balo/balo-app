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
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';

interface ProposalComposerPageProps {
  params: Promise<{ requestId: string; relationshipId: string }>;
}

// Private dashboard surface — never indexed, leak-free title.
export const metadata: Metadata = {
  title: 'Build proposal — Balo',
  robots: { index: false, follow: false },
};

function firstNameOf(firstName: string | null, fallback: string): string {
  const trimmed = (firstName ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
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
 * The dedicated proposal composer surface (A6.2 / BAL-288). Deep-linkable from the
 * A5 "Build your proposal →" email at
 * `/projects/{requestId}/proposal/{relationshipId}`.
 *
 * GUARD (defence-in-depth — the Build CTA already gates): only the EXPERT on this
 * relationship, at `proposal_requested`, may open. Any other lens / status / a
 * foreign relationshipId redirects back to the request detail (no existence leak;
 * mirrors the request-detail page's `resolveRequestLens` gate).
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
    log.error('Failed to load request for proposal composer', {
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

  // Expert-lens guard: must be the expert on THIS relationship.
  if (ctx?.lens !== 'expert' || ctx.relationshipId !== relationshipId) {
    log.warn('Proposal composer access denied', {
      requestId,
      relationshipId,
      userId: user.id,
      lens: ctx?.lens ?? null,
    });
    redirect(`/projects/${requestId}`);
  }

  const relationship = request.relationships.find((r) => r.id === relationshipId);
  // Only openable while the client has requested a proposal (drafts live here).
  if (relationship === undefined || relationship.status !== 'proposal_requested') {
    redirect(`/projects/${requestId}`);
  }

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
