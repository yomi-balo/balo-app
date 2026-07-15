import 'server-only';
import {
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
  proposalDocumentsRepository,
  proposalsRepository,
  type Proposal,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { hydrateReviewDoc } from '@/lib/project-request/proposal-audience-view';
import { proposalPdfKey, putProposalPdfToR2 } from '@/lib/storage/proposal-pdf';
import { renderProposalPdfToBuffer } from '@/lib/project-request/proposal/pdf/proposal-pdf-document';

type Relationship = ProjectRequestWithRelations['relationships'][number];

/** The inputs every client-PDF render needs: the request, the relationship on it, and the proposal. */
export interface ClientPdfTarget {
  request: ProjectRequestWithRelations;
  relationship: Relationship;
  proposal: Proposal;
}

/**
 * Render the Balo-branded, CLIENT-facing proposal PDF bytes. The serializer
 * audience is ALWAYS `client` — the Balo fee / raw expert quote (which live only
 * on the `admin` audience doc) never reach the rendered document. This is the
 * single client-PDF render path, shared by the BAL-385 download route and the
 * BAL-386 share force-generate, so the two can never drift (SonarCloud
 * new-code duplication gate).
 */
export async function generateClientProposalPdf(target: ClientPdfTarget): Promise<Uint8Array> {
  const { request, relationship, proposal } = target;
  const [milestones, installments, documents, orgName] = await Promise.all([
    proposalMilestonesRepository.listByProposal(proposal.id),
    proposalPaymentInstallmentsRepository.listByProposal(proposal.id),
    proposalDocumentsRepository.listByProposal(proposal.id),
    proposalsRepository.findExpertOrgName(proposal.id),
  ]);
  const doc = hydrateReviewDoc(
    proposal,
    milestones,
    installments,
    documents,
    relationship,
    'client'
  );
  return renderProposalPdfToBuffer({
    doc,
    title: request.title,
    clientCompanyName: request.company?.name ?? 'your company',
    preparedByOrgName: orgName,
    generatedAtIso: new Date().toISOString(),
  });
}

/**
 * Force-generate the client PDF and write it to R2 UNCONDITIONALLY (BAL-386).
 * Unlike the download route's read-through cache, this always re-renders and
 * overwrites so the R2 object at `proposalPdfKey(proposal.id)` is guaranteed to
 * exist (and be current) before a `proposal.shared` event is published — the
 * delivery worker reads those bytes by key at send time.
 */
export async function ensureClientProposalPdf(target: ClientPdfTarget): Promise<void> {
  const bytes = await generateClientProposalPdf(target);
  await putProposalPdfToR2(proposalPdfKey(target.proposal.id), bytes);
}

/**
 * Header-safe download filename: collapse every non-alphanumeric run to a single
 * hyphen (linear regex — no backtracking alternation), then trim the at-most-one
 * leading/trailing hyphen with plain string ops (avoids the super-linear `/-+$/`).
 * Shared by the download route (Content-Disposition) and the share attachment spec.
 */
export function proposalPdfFileName(title: string, version: number): string {
  let slug = title.replaceAll(/[^a-zA-Z0-9]+/g, '-').slice(0, 60);
  if (slug.startsWith('-')) {
    slug = slug.slice(1);
  }
  if (slug.endsWith('-')) {
    slug = slug.slice(0, -1);
  }
  const base = slug.length > 0 ? slug : 'proposal';
  return `Balo-Proposal-${base}-v${version}.pdf`;
}
