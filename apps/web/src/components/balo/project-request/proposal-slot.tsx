import Link from 'next/link';
import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import type { RelationshipStatus } from '@/lib/project-request/conversation-view-types';

interface ProposalSlotProps {
  /** The request whose composer this slot links to. */
  requestId: string;
  /**
   * The VIEWER-expert's own relationship status (`view.viewerRelationshipStatus`)
   * — `null` for the client/admin lenses, which never render this slot.
   */
  viewerRelationshipStatus: RelationshipStatus | null;
  /**
   * The VIEWER-expert's own relationship id (`ctx.relationshipId`) — required to
   * deep-link the live "Build proposal" CTA to the composer. `null` for the
   * client/admin lenses (the slot never renders for them anyway).
   */
  viewerRelationshipId: string | null;
}

/**
 * Relationship statuses BEFORE the client has requested this expert's proposal —
 * the slot shows the gated "Awaiting proposal request" pill. At `proposal_requested`
 * the slot becomes the live "Build proposal" CTA (BAL-288 / A6.2 — deep-links to
 * the composer).
 */
const AWAITING_PROPOSAL_REQUEST = new Set<RelationshipStatus>(['invited', 'eoi_submitted']);

const PROPOSAL_CTA_CLASS = cn(
  'focus-visible:ring-ring inline-flex min-h-9 items-center gap-1.5 rounded-[9px] px-3.5 py-1.5 text-[13px] font-bold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none',
  PROPOSAL_CTA_GRADIENT_CLASS
);

/**
 * The expert-lens "Build proposal" header slot. Keyed on the VIEWER'S OWN
 * relationship status, not the request aggregate (BAL-272 divergence fix): once
 * any expert's proposal is requested the request status advances for everyone,
 * but this expert's pill must persist until THEIR proposal is requested.
 *
 * - `invited` / `eoi_submitted` → the gated "Awaiting proposal request" pill.
 * - `proposal_requested` → the live "Build proposal" CTA → the composer (A6.2).
 * - `proposal_submitted`+ → `null` (A6.3 owns the "View" CTA — the slot yields).
 */
export function ProposalSlot({
  requestId,
  viewerRelationshipStatus,
  viewerRelationshipId,
}: Readonly<ProposalSlotProps>): React.JSX.Element | null {
  if (viewerRelationshipStatus === null) return null;

  if (viewerRelationshipStatus === 'proposal_requested' && viewerRelationshipId !== null) {
    return (
      <Link
        href={`/projects/${requestId}/proposal/${viewerRelationshipId}`}
        className={PROPOSAL_CTA_CLASS}
      >
        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        Build proposal
      </Link>
    );
  }

  if (!AWAITING_PROPOSAL_REQUEST.has(viewerRelationshipStatus)) {
    return null;
  }

  return (
    <span
      aria-disabled="true"
      className="border-border bg-muted/50 text-muted-foreground inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium"
    >
      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
      Awaiting proposal request
    </span>
  );
}
