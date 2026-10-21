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
  proposalChangeRequestsRepository,
  proposalShareLinksRepository,
  type Proposal,
  type ProposalMilestone,
  type ProposalPaymentInstallment,
  type ProposalDocument,
  type ProposalShareLink,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import {
  resolveRequestLens,
  type RequestViewerContext,
} from '@/lib/project-request/resolve-request-lens';
import { RichText } from '@/components/balo/project-request/rich-text';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { ProposalComposer } from '@/components/balo/project-request/proposal/proposal-composer';
import {
  emptyDraftState,
  hydrateMilestonePricing,
  nextDraftKey,
  seedInstallments,
  type ProposalDraftState,
} from '@/components/balo/project-request/proposal/proposal-composer-state';
import { ProposalSent } from '@/components/balo/project-request/proposal/proposal-sent';
import { ProposalReview } from '@/components/balo/project-request/proposal/proposal-review';
import { SubmittedView } from '@/components/balo/project-request/proposal/submitted-view';
import type { ProposalReviewDoc } from '@/components/balo/project-request/proposal/proposal-review-types';
import {
  expertIdentityOf,
  hydrateReviewDoc,
  type ProposalAudience,
} from '@/lib/project-request/proposal-audience-view';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import type { SharedLinkView } from '@/lib/project-request/proposal/share-view-types';

interface ProposalComposerPageProps {
  params: Promise<{ requestId: string; relationshipId: string }>;
  searchParams: Promise<{ sent?: string | string[] }>;
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

/** `?sent=` as a positive integer, or `null` for anything else (absent, repeated, malformed). */
function parseSentVersion(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) {
    return null;
  }
  return Number(value);
}

function firstNameOf(firstName: string | null, fallback: string): string {
  const trimmed = (firstName ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Full name from first/last, or the fallback when both are blank. */
function fullNameOf(firstName: string | null, lastName: string | null, fallback: string): string {
  const full = [firstName, lastName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ');
  return full.length > 0 ? full : fallback;
}

/** Map a share-link row to the client-safe view (BAL-386) — token/hash never cross. */
function toSharedLinkView(link: ProposalShareLink): SharedLinkView {
  return {
    id: link.id,
    recipientEmail: link.recipientEmail,
    sharedOnIso: link.createdAt.toISOString(),
    lastAccessedIso: link.lastAccessedAt === null ? null : link.lastAccessedAt.toISOString(),
    expiresAtIso: link.expiresAt.toISOString(),
  };
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
  // "Price each milestone" is on only when a milestone carries a positive amount. With it
  // off, every amount hydrates as null so legacy 0-seeded drafts never surface "A$0" and
  // the next save persists null.
  const milestonePricingEnabled = isFixed && hydrateMilestonePricing(milestones);
  const hydratedMilestones =
    milestones.length > 0
      ? milestones.map((m) => ({
          key: nextDraftKey(),
          title: m.title,
          descriptionHtml: m.descriptionHtml ?? '',
          acceptanceCriteria: m.acceptanceCriteria ?? '',
          valueCents: milestonePricingEnabled ? m.valueCents : null,
          estimatedMinutes: m.estimatedMinutes,
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
    // The persisted `priceCents` IS the typed Fixed total (BAL-294); seed it only
    // under Fixed so a switch back restores it. Null under T&M (the total derives).
    fixedPriceCents: isFixed ? draft.priceCents : null,
    cadence: draft.cadence ?? 'monthly',
    milestones: hydratedMilestones,
    milestonePricingEnabled,
    installments: isFixed ? hydratedInstallments : [],
    documents: documents.map(documentToView),
  };
}

/**
 * Load a relationship's current proposal (+ children, in parallel) and hydrate it
 * into an audience-resolved {@link ProposalReviewDoc} (BAL-357 — money is resolved
 * for `audience`: raw for expert/admin-base, `applyBaloFee`'d for client). Returns
 * `null` when the relationship has no current proposal, or its status isn't
 * reviewable (e.g. `draft`/`withdrawn`).
 */
async function loadReviewDoc(
  relationship: Relationship,
  audience: ProposalAudience
): Promise<ProposalReviewDoc | null> {
  const proposal = await proposalsRepository.findCurrentByRelationship(relationship.id);
  if (proposal === undefined || !REVIEWABLE_PROPOSAL_STATUSES.has(proposal.status)) {
    return null;
  }
  const [milestones, installments, documents] = await Promise.all([
    proposalMilestonesRepository.listByProposal(proposal.id),
    proposalPaymentInstallmentsRepository.listByProposal(proposal.id),
    proposalDocumentsRepository.listByProposal(proposal.id),
  ]);
  return hydrateReviewDoc(proposal, milestones, installments, documents, relationship, audience);
}

/**
 * Load a proposal's children (milestones, installments, documents) in parallel and
 * hydrate the composer's initial {@link ProposalDraftState}. Shared by the draft
 * composer (A6.2) and the revise composer (A6.4) — same hydration either way. When
 * `proposal` is `undefined` (no draft yet) the composer starts from an empty draft.
 */
async function hydrateComposerState(proposal: Proposal | undefined): Promise<ProposalDraftState> {
  const [milestones, installments, documents] =
    proposal === undefined
      ? [[], [], []]
      : await Promise.all([
          proposalMilestonesRepository.listByProposal(proposal.id),
          proposalPaymentInstallmentsRepository.listByProposal(proposal.id),
          proposalDocumentsRepository.listByProposal(proposal.id),
        ]);
  return hydrateDraftState(proposal, milestones, installments, documents);
}

/** Outer layout wrapper shared by the composer and its in-place sent screen. */
function ComposerShell({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="mx-auto max-w-6xl">{children}</div>;
}

/**
 * The composer header: back link, "Proposal for {company}" (with the version chip when
 * revising) and the request title as the page heading. Passed into the composer, which
 * shows it only while editing; the server cannot know the client-side mode.
 */
function ComposerHeader({
  requestId,
  requestTitle,
  companyName,
  revise,
}: Readonly<{
  requestId: string;
  requestTitle: string;
  companyName: string;
  revise?: { nextVersion: number };
}>): React.JSX.Element {
  return (
    <div className="mb-5">
      <Link
        href={`/projects/${requestId}`}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to {requestTitle}
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-[13px]">
          Proposal for <span className="text-foreground font-medium">{companyName}</span>
        </p>
        {revise !== undefined && (
          <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium">
            Version {revise.nextVersion}
          </span>
        )}
      </div>
      <h1 className="text-foreground mt-1 text-2xl font-semibold tracking-tight sm:text-[30px]">
        {requestTitle}
      </h1>
    </div>
  );
}

/** The client company's display name, with the expert-lens fallback. */
function companyNameOf(request: ProjectRequestWithRelations): string {
  return request.company?.name ?? 'the client';
}

/** The requesting client's full name, falling back to their first name. */
function clientNameOf(request: ProjectRequestWithRelations): string {
  return fullNameOf(
    request.createdByUser.firstName,
    request.createdByUser.lastName,
    firstNameOf(request.createdByUser.firstName, 'the client')
  );
}

/** Props both composer mounts share, derived from the request and the viewed relationship. */
function composerBriefProps(
  request: ProjectRequestWithRelations,
  relationship: Relationship
): {
  clientFirstName: string;
  clientName: string;
  companyName: string;
  clientCompanyName: string | null;
  requestTitle: string;
  requestSummary: string;
  requestDescription: React.ReactNode;
  expert: ReturnType<typeof expertIdentityOf>;
} {
  const clientFirstName = firstNameOf(request.createdByUser.firstName, 'the client');
  return {
    clientFirstName,
    clientName: clientNameOf(request),
    companyName: companyNameOf(request),
    clientCompanyName: request.company?.name ?? null,
    requestTitle: request.title,
    requestSummary: htmlToPlainText(request.description),
    requestDescription: <RichText html={request.description} size="sm" />,
    expert: expertIdentityOf(relationship),
  };
}

/**
 * The EXPERT proposal composer surface (A6.2 / BAL-288), unchanged. Deep-linkable
 * from the A5 "Build your proposal →" email; only the expert on THIS relationship,
 * at `proposal_requested`, reaches here (the dispatcher gates).
 */
async function renderComposer(
  requestId: string,
  relationshipId: string,
  request: ProjectRequestWithRelations,
  relationship: Relationship
): Promise<React.JSX.Element> {
  const draft = await proposalsRepository.findCurrentByRelationship(relationshipId);
  const initialState = await hydrateComposerState(draft);
  const brief = composerBriefProps(request, relationship);

  return (
    <ComposerShell>
      <ProposalComposer
        requestId={requestId}
        relationshipId={relationshipId}
        initialState={initialState}
        header={
          <ComposerHeader
            requestId={requestId}
            requestTitle={brief.requestTitle}
            companyName={brief.companyName}
          />
        }
        {...brief}
      />
    </ComposerShell>
  );
}

/**
 * The EXPERT revise composer (A6.4 / BAL-290). Re-entry after the client requested
 * changes: the relationship stays `proposal_submitted` while the CURRENT proposal is
 * `changes_requested`. Hydrates from that current proposal (same hydration as the
 * draft composer), loads the latest change-request note, and renders the composer in
 * revise mode — autosave off, "Resubmit as v{n}", the client's note pinned.
 */
async function renderReviseComposer(
  requestId: string,
  relationshipId: string,
  request: ProjectRequestWithRelations,
  relationship: Relationship,
  current: Proposal
): Promise<React.JSX.Element> {
  const [initialState, changeRequests] = await Promise.all([
    hydrateComposerState(current),
    proposalChangeRequestsRepository.listByProposal(current.id),
  ]);
  // `listByProposal` returns newest-first — the most recent note frames the revise.
  const [latest] = changeRequests;
  const brief = composerBriefProps(request, relationship);
  const changeRequest =
    latest === undefined ? undefined : { note: latest.note, section: latest.section };

  return (
    <ComposerShell>
      <ProposalComposer
        requestId={requestId}
        relationshipId={relationshipId}
        initialState={initialState}
        header={
          <ComposerHeader
            requestId={requestId}
            requestTitle={brief.requestTitle}
            companyName={brief.companyName}
            revise={{ nextVersion: current.version + 1 }}
          />
        }
        {...brief}
        changeRequest={changeRequest}
        fromProposalId={current.id}
        currentVersion={current.version}
      />
    </ComposerShell>
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
 * EXPERT lens surface (own relationship only). Returns the composer at
 * `proposal_requested`, the read-only SubmittedView once a proposal exists, or
 * `null` (no match — the dispatcher falls through to the next lens).
 */
async function renderExpertSurface(
  ctx: RequestViewerContext,
  relationship: Relationship,
  request: ProjectRequestWithRelations,
  requestId: string,
  relationshipId: string,
  clientFirstName: string,
  sent: number | null
): Promise<React.JSX.Element | null> {
  if (ctx.lens !== 'expert' || ctx.relationshipId !== relationshipId) {
    return null;
  }
  // Composer: the draft surface while the client is awaiting a proposal.
  if (relationship.status === 'proposal_requested') {
    return renderComposer(requestId, relationshipId, request, relationship);
  }
  // Revise composer (A6.4 / BAL-290): the relationship stays `proposal_submitted`
  // while the CURRENT proposal is `changes_requested` — re-enter the composer to
  // revise and resubmit as v{n+1}.
  if (SUBMITTED_RELATIONSHIP_STATUSES.has(relationship.status)) {
    const current = await proposalsRepository.findCurrentByRelationship(relationshipId);
    if (current !== undefined && current.status === 'changes_requested') {
      return renderReviseComposer(requestId, relationshipId, request, relationship, current);
    }
    // The in-place sent screen: the send redirects to `?sent={version}`, which only
    // renders when it names the latest version and that version is still awaiting the client.
    if (
      current !== undefined &&
      current.status === 'submitted' &&
      sent !== null &&
      sent === current.version
    ) {
      return (
        <ComposerShell>
          <ProposalSent
            requestId={requestId}
            companyName={companyNameOf(request)}
            clientCompanyName={request.company?.name ?? null}
            clientName={clientNameOf(request)}
            reviseMode={current.version > 1}
            version={current.version}
          />
        </ComposerShell>
      );
    }
  }
  // Submitted view: read-only "awaiting the client" once a proposal exists.
  if (SUBMITTED_RELATIONSHIP_STATUSES.has(relationship.status)) {
    const doc = await loadReviewDoc(relationship, 'expert');
    if (doc !== null) {
      return (
        <ReviewShell requestId={requestId} title={request.title}>
          <SubmittedView
            lens="expert"
            requestId={requestId}
            doc={doc}
            clientName={clientFirstName}
            otherProposalCount={otherSubmittedCount(request, relationshipId)}
          />
        </ReviewShell>
      );
    }
  }
  return null;
}

/**
 * CLIENT lens surface (owns the request). Returns the ProposalReview switcher
 * across every reviewable proposal on the request, or `null` (no match).
 *
 * NOTE: `changes_requested` is a *proposal* status, not a *relationship* status —
 * the relationship stays at `proposal_submitted` while the expert revises.
 * `loadReviewDoc` admits a `changes_requested` proposal, and `ProposalReview`
 * renders its "awaiting revision" empty state.
 */
async function renderClientReview(
  ctx: RequestViewerContext,
  relationship: Relationship,
  request: ProjectRequestWithRelations,
  requestId: string,
  relationshipId: string,
  clientFirstName: string
): Promise<React.JSX.Element | null> {
  if (ctx.lens !== 'client' || !SUBMITTED_RELATIONSHIP_STATUSES.has(relationship.status)) {
    return null;
  }
  // Every reviewable proposal on the request powers the switcher.
  const docs = await Promise.all(request.relationships.map((r) => loadReviewDoc(r, 'client')));
  const reviewableDocs = docs.filter((d): d is ProposalReviewDoc => d !== null);
  if (reviewableDocs.length === 0) {
    return null;
  }

  // Active share links per reviewable relationship (BAL-386). A fetch failure
  // degrades to the card's error state rather than failing the whole page.
  let sharedLinksByRelationship: Record<string, SharedLinkView[]> = {};
  let shareLinksErrored = false;
  try {
    const entries = await Promise.all(
      reviewableDocs.map(async (doc) => {
        const rows = await proposalShareLinksRepository.listActiveByRelationship(
          doc.relationshipId
        );
        return [doc.relationshipId, rows.map(toSharedLinkView)] as const;
      })
    );
    sharedLinksByRelationship = Object.fromEntries(entries);
  } catch (error) {
    shareLinksErrored = true;
    log.error('Failed to load proposal share links', {
      requestId,
      relationshipId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  return (
    <ReviewShell requestId={requestId} title={request.title}>
      <ProposalReview
        requestId={requestId}
        proposals={reviewableDocs}
        activeRelationshipId={relationshipId}
        clientCompanyName={request.company?.name ?? 'your company'}
        clientFirstName={clientFirstName}
        sharedLinksByRelationship={sharedLinksByRelationship}
        shareLinksErrored={shareLinksErrored}
      />
    </ReviewShell>
  );
}

/**
 * ADMIN lens surface (observer). Returns the read-only SubmittedView (admin
 * framing) once a proposal exists, or `null` (no match).
 */
async function renderAdminSurface(
  ctx: RequestViewerContext,
  relationship: Relationship,
  request: ProjectRequestWithRelations,
  requestId: string,
  relationshipId: string,
  clientFirstName: string
): Promise<React.JSX.Element | null> {
  if (ctx.lens !== 'admin' || !SUBMITTED_RELATIONSHIP_STATUSES.has(relationship.status)) {
    return null;
  }
  const doc = await loadReviewDoc(relationship, 'admin');
  if (doc !== null) {
    return (
      <ReviewShell requestId={requestId} title={request.title}>
        <SubmittedView
          lens="admin"
          requestId={requestId}
          doc={doc}
          clientName={clientFirstName}
          otherProposalCount={otherSubmittedCount(request, relationshipId)}
        />
      </ReviewShell>
    );
  }
  return null;
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
  searchParams,
}: Readonly<ProposalComposerPageProps>): Promise<React.JSX.Element> {
  const { requestId, relationshipId } = await params;
  const sent = parseSentVersion((await searchParams).sent);

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

  // Dispatch by lens — each helper returns its surface, or `null` to fall through
  // to the next lens (and ultimately the shared deny + redirect below).
  const expert = await renderExpertSurface(
    ctx,
    relationship,
    request,
    requestId,
    relationshipId,
    clientFirstName,
    sent
  );
  if (expert !== null) return expert;

  const client = await renderClientReview(
    ctx,
    relationship,
    request,
    requestId,
    relationshipId,
    clientFirstName
  );
  if (client !== null) return client;

  const admin = await renderAdminSurface(
    ctx,
    relationship,
    request,
    requestId,
    relationshipId,
    clientFirstName
  );
  if (admin !== null) return admin;

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
