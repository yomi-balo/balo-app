'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-502 — group-level error boundary for `(marketing)`. Catches render-time throws in the
 * layout (the session read itself already degrades gracefully to the signed-out header — see
 * `layout.tsx` — so this only fires on a genuinely unexpected render failure). The thrown
 * error is reported to Sentry by the global handler; this boundary only renders the fallback.
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
