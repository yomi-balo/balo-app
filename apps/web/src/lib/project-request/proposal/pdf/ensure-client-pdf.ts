import 'server-only';
import {
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
  proposalDocumentsRepository,
  proposalClausesRepository,
  proposalsRepository,
  type Proposal,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { hydrateReviewDoc } from '@/lib/project-request/proposal-audience-view';
import { log } from '@/lib/logging';
import {
  acceptedProposalPdfKey,
  getProposalPdfFromR2,
  isPreconditionFailedError,
  proposalPdfKey,
  putProposalPdfToR2,
} from '@/lib/storage/proposal-pdf';
import { PROJECT_TERMS_PAGE_PATH } from '@/lib/legal/project-terms-versions';
import { resolveSiteOrigin } from '@/lib/site-url';
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
  const [milestones, installments, documents, clauses, orgName] = await Promise.all([
    proposalMilestonesRepository.listByProposal(proposal.id),
    proposalPaymentInstallmentsRepository.listByProposal(proposal.id),
    proposalDocumentsRepository.listByProposal(proposal.id),
    proposalClausesRepository.listByProposal(proposal.id),
    proposalsRepository.findExpertOrgName(proposal.id),
  ]);
  const doc = hydrateReviewDoc(proposal, relationship, {
    audience: 'client',
    milestones,
    installments,
    documents,
    clauses,
    clientCompanyName: request.company?.name ?? 'the client',
  });
  return renderProposalPdfToBuffer({
    doc,
    title: request.title,
    clientCompanyName: request.company?.name ?? 'your company',
    preparedByOrgName: orgName,
    generatedAtIso: new Date().toISOString(),
    projectTermsUrl: `${resolveSiteOrigin()}${PROJECT_TERMS_PAGE_PATH}`,
  });
}

/**
 * Freeze an accepted proposal's client PDF at `acceptedProposalPdfKey` (BAL-668).
 * One rule: serve the stored copy, or store a new one and then serve it. Returns the
 * key it froze at alongside the bytes, so a caller that needs the key (share) reads
 * it from here rather than naming the accepted key itself.
 *
 * - A stored copy is returned as-is, with no render and no write.
 * - A read error other than not-found throws and nothing is written, so a transient
 *   R2 blip can never overwrite a frozen copy.
 * - The write is conditional (`ifAbsent`), so storage guarantees the object is written
 *   once. If a concurrent writer got there first, the stored copy wins: it is re-read
 *   and returned, and the bytes just rendered are discarded.
 * - Any other write failure throws, and so does a refused write whose stored copy
 *   cannot be re-read, so this never returns bytes it did not persist. Callers map
 *   the throw (route → 500, share → `send_failed`, accept → warning).
 *
 * This is the ONLY writer of the accepted key. It does not check proposal status —
 * callers own that gate. It renders `doc.status`-free content, so the pre-commit row
 * the accept core holds is safe to pass. The success log carries
 * `secondsSinceAccepted` from `proposal.acceptedAt`: null at accept time (the core
 * holds the pre-commit row), a number when the freeze happened lazily afterwards.
 */
export async function freezeAcceptedProposalPdf(
  target: ClientPdfTarget
): Promise<{ key: string; bytes: Uint8Array }> {
  const key = acceptedProposalPdfKey(target.proposal.id);
  const stored = await getProposalPdfFromR2(key);
  if (stored !== null) {
    return { key, bytes: stored };
  }
  const bytes = await generateClientProposalPdf(target);
  try {
    await putProposalPdfToR2(acceptedProposalPdfKey(target.proposal.id), bytes, {
      ifAbsent: true,
    });
  } catch (error) {
    if (!isPreconditionFailedError(error)) {
      throw error;
    }
    const winner = await getProposalPdfFromR2(key);
    if (winner === null) {
      throw error;
    }
    log.info('Accepted proposal PDF already frozen by a concurrent writer', {
      proposalId: target.proposal.id,
      relationshipId: target.relationship.id,
    });
    return { key, bytes: winner };
  }
  const { acceptedAt } = target.proposal;
  log.info('Accepted proposal PDF frozen', {
    proposalId: target.proposal.id,
    relationshipId: target.relationship.id,
    version: target.proposal.version,
    secondsSinceAccepted: acceptedAt
      ? Math.round((Date.now() - acceptedAt.getTime()) / 1000)
      : null,
  });
  return { key, bytes };
}

/**
 * Force-generate the client PDF of a NON-ACCEPTED proposal and write it to R2
 * UNCONDITIONALLY (BAL-386). Unlike the download route's read-through cache, this
 * always re-renders and overwrites so the R2 object at `proposalPdfKey(proposal.id)`
 * is guaranteed to exist (and be current) before a `proposal.shared` event is
 * published — the delivery worker reads those bytes by key at send time. An
 * accepted proposal goes through {@link freezeAcceptedProposalPdf} instead.
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
