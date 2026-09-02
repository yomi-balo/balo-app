import Link from 'next/link';
import { AlertCircle, Loader2 } from 'lucide-react';
import { SETTLEMENT_STATUS_COPY, STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

/** The three statuses this note ever renders for. `not_required` and `settled` render nothing. */
const RENDERED_STATUSES = new Set(['processing', 'failed', 'requires_action']);

/**
 * CLIENT-lens only. Renders a status chip + one muted line, but ONLY for `processing`, `failed`,
 * `requires_action` — never for `not_required` (the ordinary fully-funded session) and never for
 * `settled` (the total already says it was charged and settled). Amber (`warning` token), never
 * destructive-red — matches the dunning email's "quick heads-up" register. "Extra time", NEVER
 * "overdraft" (CLAUDE.md).
 */
export function SettlementStatusNote({
  settlementStatus,
}: Readonly<{ settlementStatus: string }>): React.JSX.Element | null {
  if (!RENDERED_STATUSES.has(settlementStatus)) {
    return null;
  }
  const body = SETTLEMENT_STATUS_COPY[settlementStatus];
  if (body === undefined) {
    return null;
  }
  const isProcessing = settlementStatus === 'processing';

  return (
    <div className="border-warning/30 bg-warning/10 mt-4 flex items-start gap-2.5 rounded-lg border px-3.5 py-3">
      {isProcessing ? (
        <Loader2
          size={14}
          className="text-warning mt-0.5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <AlertCircle size={14} className="text-warning mt-0.5" aria-hidden="true" />
      )}
      <p className="text-foreground text-sm leading-relaxed">
        {body}
        {!isProcessing && (
          <>
            {' '}
            <Link
              href="/billing"
              className="text-warning focus-visible:ring-ring rounded-sm font-medium underline focus-visible:ring-2 focus-visible:outline-none"
            >
              {STATEMENT_SHARED_COPY.manageBillingLink}
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
