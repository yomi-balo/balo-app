'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary for `/experts/[username]`. Catches render-time
 * throws including the re-thrown profile-fetch failure from the page. The thrown
 * error is reported to Sentry by the global handler; this boundary only renders
 * the fallback UI with a retry.
 */
export default function ExpertProfileError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" />
      </div>
      <h1 className="text-foreground text-lg font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
        We couldn&apos;t load this expert profile. This might be a temporary issue.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4">
        Try again
      </Button>
    </div>
  );
}
