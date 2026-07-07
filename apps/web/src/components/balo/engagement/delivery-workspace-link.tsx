import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

interface DeliveryWorkspaceLinkProps {
  engagementId: string;
}

/**
 * Deep-link entry into the delivery workspace, rendered by the request-detail
 * shell once a request is `kickoff_approved`. The `?from=request_detail` query
 * is the analytics `entry` whitelist source (the workspace page reads it), so
 * the literal must be kept exactly. Navigational only — no mutations.
 */
export function DeliveryWorkspaceLink({
  engagementId,
}: Readonly<DeliveryWorkspaceLinkProps>): React.JSX.Element {
  return (
    <Link
      href={`/engagements/${engagementId}?from=request_detail`}
      className="text-primary inline-flex items-center gap-1 text-sm font-semibold transition-opacity hover:opacity-90"
    >
      View delivery workspace
      <ChevronRight aria-hidden="true" className="size-4" />
    </Link>
  );
}
