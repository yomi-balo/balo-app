import { FileText } from 'lucide-react';
import type { RelationshipStatus } from '@/lib/project-request/conversation-view-types';

interface ProposalSlotProps {
  /**
   * The VIEWER-expert's own relationship status (`view.viewerRelationshipStatus`)
   * — `null` for the client/admin lenses, which never render this slot.
   */
  viewerRelationshipStatus: RelationshipStatus | null;
}

/**
 * Relationship statuses BEFORE the client has requested this expert's proposal —
 * the slot shows the gated "Awaiting proposal request" pill. At/after
 * `proposal_requested` the slot yields the space to A6's live "Build proposal"
 * CTA (renders `null`).
 */
const AWAITING_PROPOSAL_REQUEST = new Set<RelationshipStatus>(['invited', 'eoi_submitted']);

/**
 * The expert-lens "Build proposal" header slot, GATED (BAL-270 / A3). Keyed on
 * the VIEWER'S OWN relationship status, not the request aggregate (BAL-272
 * divergence fix): once any expert's proposal is requested the request status
 * advances for everyone, but this expert's pill must persist until THEIR
 * proposal is requested. Render-only server component.
 *
 * Returns `null` once the viewer's proposal has been requested (A6 owns the
 * live CTA — the slot simply yields the space).
 */
export function ProposalSlot({
  viewerRelationshipStatus,
}: Readonly<ProposalSlotProps>): React.JSX.Element | null {
  if (
    viewerRelationshipStatus === null ||
    !AWAITING_PROPOSAL_REQUEST.has(viewerRelationshipStatus)
  ) {
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
