'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CASES_INDEX_ERROR_BODY,
  CASES_INDEX_ERROR_TITLE,
  CASES_INDEX_RETRY,
} from './_lib/cases-index-copy';

/**
 * BAL-567 — the `/cases` route segment's error boundary.
 *
 * ⚠ IT IS THE SECOND LINE, NOT THE FIRST. `readCasesIndexData` already catches a failed READ and
 * renders the shell's own error state (which keeps the page chrome), so this boundary only ever
 * sees a failure OUTSIDE that seam — a render error, or a throw from the session/nav resolution
 * above it. Both exist, and a segment with no boundary would take the whole dashboard down.
 *
 * ⚠ THE COPY IS THE SHARED CONSTANT, so the two error surfaces say the same thing.
 */
export default function CasesError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive size-8" aria-hidden="true" />
      </div>
      <h2 className="text-foreground text-lg font-semibold">{CASES_INDEX_ERROR_TITLE}</h2>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">{CASES_INDEX_ERROR_BODY}</p>
      <Button onClick={reset} variant="outline" className="mt-4">
        {CASES_INDEX_RETRY}
      </Button>
    </div>
  );
}
