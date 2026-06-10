import { FileText } from 'lucide-react';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';

interface ProposalSlotProps {
  requestStatus: ProjectRequestStatus;
}

/**
 * Statuses at/after which the client has requested a proposal — the expert's
 * "Build proposal" CTA becomes actionable. Before any of these, the expert sees
 * the gated "Awaiting proposal request" pill (A3 renders ONLY this gated state).
 */
const PROPOSAL_REQUESTED_STATUSES = new Set<ProjectRequestStatus>([
  'proposal_requested',
  'proposal_submitted',
  'accepted',
  'kickoff_approved',
]);

/**
 * The expert-lens "Build proposal" header slot, GATED (BAL-270 / A3). Until the
 * client requests a proposal (request status `< proposal_requested`), this renders
 * a disabled "Awaiting proposal request" pill — no button, no handler. A6 replaces
 * the gated pill with the live "Build proposal" CTA once the client has requested
 * one. Render-only server component; reads only `view.status`.
 *
 * Returns `null` once a proposal has been requested (A3 does not own the live CTA
 * yet — the slot simply yields the space to A6).
 */
export function ProposalSlot({
  requestStatus,
}: Readonly<ProposalSlotProps>): React.JSX.Element | null {
  if (PROPOSAL_REQUESTED_STATUSES.has(requestStatus)) return null;

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
