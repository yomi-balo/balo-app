'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary for `/experts`. Catches render-time throws not caught
 * inside the page (the page already catches the data-fetch seam). Provides a
 * graceful fallback with a retry. The thrown error is reported to Sentry by the
 * global handler; this boundary only renders the fallback UI.
 */
export default function ExpertsError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" />
      </div>
      <h1 className="text-foreground text-lg font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
        We couldn&apos;t load the expert search. This might be a temporary issue.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4">
        Try again
      </Button>
    </div>
  );
}
