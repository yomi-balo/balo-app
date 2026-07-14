import { Download } from 'lucide-react';

interface ProposalPdfDownloadLinkProps {
  requestId: string;
  relationshipId: string;
}

/**
 * "Download PDF" entry point (BAL-385) for the client-facing proposal PDF. A plain
 * browser download (`<a download>`) pointing at the authorized GET route — NOT a
 * mutation, so no Sonner toast (the browser owns download progress). The route
 * re-checks lens + status server-side, so this hidden-by-default button is
 * defense-in-depth, not the security boundary.
 *
 * Deliberately free of any `@balo/db` value import: a client component that
 * value-imports the DB barrel breaks `next build` (the barrel re-exports
 * `postgres` → unresolved `tls`). This stays a pure anchor.
 */
export function ProposalPdfDownloadLink({
  requestId,
  relationshipId,
}: Readonly<ProposalPdfDownloadLinkProps>): React.JSX.Element {
  const href = `/projects/${requestId}/proposal/${relationshipId}/pdf`;
  return (
    <a
      href={href}
      download
      className="text-primary hover:bg-primary/10 focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      Download PDF
    </a>
  );
}
