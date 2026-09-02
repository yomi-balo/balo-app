'use client';

import Link from 'next/link';
import { SectionError } from '@/components/balo/section/section-states';
import { Button } from '@/components/ui/button';
import { StatementPageShell, StatementCard } from './statement-page-shell';
import { STATEMENT_COPY, STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

/**
 * Shared route-level ERROR content for BOTH `/receipt` and `/payout`. Destructures ONLY `reset`
 * — `error` is unused, matching every sibling boundary (Sentry client instrumentation already
 * captures it; `onRequestError` captures the server side). LOGS NOTHING to the console.
 */
export function StatementError({
  lens,
  reset,
}: Readonly<{ lens: 'client' | 'expert'; reset: () => void }>): React.JSX.Element {
  const copy = STATEMENT_COPY[lens];
  return (
    <StatementPageShell>
      <StatementCard>
        <SectionError label={copy.errorLabel} onRetry={reset} body={copy.errorBody} />
        <div className="mt-4 flex justify-center">
          <Button asChild variant="ghost" className="min-h-11">
            <Link href="/dashboard">{STATEMENT_SHARED_COPY.errorBackAction}</Link>
          </Button>
        </div>
      </StatementCard>
    </StatementPageShell>
  );
}
