'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-502 — group-level error boundary for `(marketing)`. Per Next.js's own contract, an
 * `error.tsx` does NOT catch an error thrown by the layout in its own segment (only errors from
 * that segment's page and nested children) — so this boundary does not, in fact, protect against
 * a `MarketingLayout` render failure. That is not a gap in practice: `layout.tsx`'s session read
 * is already try/caught and degrades to the signed-out header rather than throwing (see
 * `layout.tsx`), so there is nothing left in that layout to escape upward. This boundary exists
 * for genuinely unexpected failures in the PAGE tree beneath it. The thrown error is reported to
 * Sentry by the global handler; this boundary only renders the fallback.
 */
export default function MarketingError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" />
      </div>
      <h1 className="text-foreground text-lg font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
        We couldn&apos;t load this page. This might be a temporary issue.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4">
        Try again
      </Button>
    </div>
  );
}
