import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  proposalShareLinksRepository,
  proposalsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  partyDomainsRepository,
  usersRepository,
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
  proposalDocumentsRepository,
} from '@balo/db';
import { cn } from '@/lib/utils';
import { log } from '@/lib/logging';
import { hydrateReviewDoc } from '@/lib/project-request/proposal-audience-view';
import { ProposalDoc } from '@/components/balo/project-request/proposal/proposal-doc';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { formatUtcLongDate } from '@/lib/format/local-date';
import { shareDisplayName } from '@/lib/project-request/proposal/share-view-types';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';
import { LinkNotActive } from './link-not-active';
import { SharedProposalHeader } from './_components/shared-proposal-header';
import { SharedProposalBanner } from './_components/shared-proposal-banner';
import { SharedProposalJoinCta } from './_components/shared-proposal-join-cta';
import { SharedProposalFooter } from './_components/shared-proposal-footer';
import { SharedProposalReveal } from './_components/shared-proposal-reveal';

// crypto (token hashing) + Drizzle need Node, not Edge.
export const runtime = 'nodejs';
// Per-token, access-stamping content — never statically cached.
export const dynamic = 'force-dynamic';

// Public magic-link page — deliberately NOT indexed. A neutral title (no proposal
// details) so nothing leaks via the tab / share preview.
export const metadata: Metadata = {
  title: 'Shared proposal — Balo',
  robots: { index: false, follow: false },
};

interface SharedProposalPageProps {
  params: Promise<{ token: string }>;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Best-effort client IP for the per-instance rate limiter (defense-in-depth). */
function clientIp(headerList: Headers): string {
  const forwarded = headerList.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  return headerList.get('x-real-ip') ?? 'unknown';
}

/** Constant-time equality of two hex strings (belt-and-braces over the DB lookup). */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * The public, no-auth, noindex shared-proposal view (BAL-386, Surface 2). Resolves a
 * live link by SHA-256 hash of the presented token, renders the LIVE current
 * client-priced proposal read-only (BAL-357 serializer + existing {@link ProposalDoc}),
 * honours accepted/withdrawn state banners, and shows a Join CTA only on a client-domain
 * match. EVERY inactive outcome (miss / expired / revoked / deleted / rate-limited)
 * collapses to the single generic {@link LinkNotActive} card — no leak, no differentiation.
 */
export default async function SharedProposalPage({
  params,
}: Readonly<SharedProposalPageProps>): Promise<React.JSX.Element> {
  const { token } = await params;
  const headerList = await headers();

  // Defense-in-depth throttle. The real control is the ≥256-bit token; on limit we
  // render the same leak-free page (never a 429 or throttle detail).
  if (!checkMemoryLimit(`shared-proposal:${clientIp(headerList)}`)) {
    return <LinkNotActive />;
  }

  const tokenHash = sha256Hex(token);
  const row = await proposalShareLinksRepository.findLiveByTokenHash(tokenHash);
  if (row === undefined || !hashesMatch(tokenHash, row.tokenHash)) {
    log.info('Shared proposal link not active', { tokenHashPrefix: tokenHash.slice(0, 8) });
    return <LinkNotActive />;
  }

  const proposal = await proposalsRepository.findCurrentByRelationship(row.relationshipId);
  if (proposal === undefined || proposal.status === 'draft') {
    return <LinkNotActive />;
  }

  const relationshipRow = await requestExpertRelationshipsRepository.findById(row.relationshipId);
  if (relationshipRow === undefined) {
    return <LinkNotActive />;
  }
  const request = await projectRequestsRepository.findByIdWithRelations(
    relationshipRow.projectRequestId
  );
  if (!request) {
    return <LinkNotActive />;
  }
  const relationship = request.relationships.find((r) => r.id === row.relationshipId);
  if (relationship === undefined) {
    return <LinkNotActive />;
  }

  // Stamp the access ONLY after every render-required lookup has resolved — all the
  // LinkNotActive bail-outs above are now behind us, so a data anomaly on an
  // otherwise-renderable proposal can no longer inflate `access_count` / consume
  // `firstOpen` while PROPOSAL_SHARE_OPENED never fires (which would make a later real
  // open falsely report first_open:false). Compute first-open BEFORE stamping
  // (access_count === 0 pre-increment); the emit below always pairs with this stamp.
  const firstOpen = row.accessCount === 0;
  await proposalShareLinksRepository.recordAccess(row.id);

  const [milestones, installments, documents, sharer, expertOrgName] = await Promise.all([
    proposalMilestonesRepository.listByProposal(proposal.id),
    proposalPaymentInstallmentsRepository.listByProposal(proposal.id),
    proposalDocumentsRepository.listByProposal(proposal.id),
    usersRepository.findById(row.createdByUserId),
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
  const clientCompany = request.company?.name ?? 'their team';
  const sharerName = sharer === undefined ? 'a colleague' : shareDisplayName(sharer);

  // Join CTA gate (ADR-1031): recipient domain must match the client company's
  // active party domain, and the proposal must not be withdrawn.
  const domain = row.recipientEmail.split('@')[1];
  let showJoinCta = false;
  if (domain !== undefined && domain.length > 0 && proposal.status !== 'withdrawn') {
    const partyDomain = await partyDomainsRepository.findActiveByDomain(domain);
    showJoinCta = partyDomain?.partyType === 'company' && partyDomain.partyId === request.companyId;
  }

  trackServerAndFlush(PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_OPENED, {
    share_link_id: row.id,
    first_open: firstOpen,
    distinct_id: `share_${row.id}`,
  });
  log.info('Shared proposal opened', { shareLinkId: row.id, firstOpen });

  const isWithdrawn = proposal.status === 'withdrawn';

  return (
    <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-sm">
      <SharedProposalReveal index={0}>
        <SharedProposalHeader sharerName={sharerName} clientCompany={clientCompany} />
        <SharedProposalBanner
          status={proposal.status}
          clientCompany={clientCompany}
          expertOrg={expertOrgName ?? 'the expert'}
          acceptedOnIso={proposal.acceptedAt === null ? null : proposal.acceptedAt.toISOString()}
        />
      </SharedProposalReveal>
      <SharedProposalReveal index={1} className={cn('p-5 sm:p-6', isWithdrawn && 'opacity-75')}>
        <ProposalDoc doc={doc} />
        {showJoinCta && <SharedProposalJoinCta clientCompany={clientCompany} />}
      </SharedProposalReveal>
      <SharedProposalReveal index={2}>
        <SharedProposalFooter
          version={proposal.version}
          expiresOn={formatUtcLongDate(row.expiresAt)}
        />
      </SharedProposalReveal>
    </div>
  );
}
