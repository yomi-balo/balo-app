import { Download } from 'lucide-react';
import { STATEMENT_COPY, STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

/**
 * A plain `<a href download>` — no `'use client'` needed, no toast (the browser owns download
 * progress). Rendered ONLY when `isStatementDownloadable(view)` (the page decides that; this
 * component just renders the link it is given).
 */
export function StatementDownloadLink({
  sessionId,
  lens,
}: Readonly<{ sessionId: string; lens: 'client' | 'expert' }>): React.JSX.Element {
  const segment = lens === 'client' ? 'receipt' : 'payout';
  return (
    <a
      href={`/sessions/${sessionId}/${segment}/pdf`}
      download
      aria-label={STATEMENT_COPY[lens].downloadAriaLabel}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-1 mt-6 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md px-1 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <Download size={14} aria-hidden="true" />
      {STATEMENT_SHARED_COPY.downloadPdf}
    </a>
  );
}
