'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { ERROR_BOUNDARY_BODY } from '@/components/layout/error-boundary-copy';
import { SectionError } from '@/components/balo/section/section-states';
import { Button } from '@/components/ui/button';

/**
 * Root error boundary. It catches throws from layouts such as `(dashboard)/layout.tsx`, which
 * the segment's own `error.tsx` cannot. The exit is a plain anchor, not `next/link`: a hard load
 * resets the client router cache.
 */
export default function RootError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  useEffect(() => {
    // Server-thrown errors carry a digest and are already reported by `onRequestError`.
    if (!error.digest) Sentry.captureException(error);
  }, [error]);

  return (
    <div className="py-12">
      <SectionError label="this page" onRetry={reset} body={ERROR_BOUNDARY_BODY} />
      <div className="mt-4 flex justify-center">
        <Button asChild variant="ghost" className="min-h-11">
          <a href="/dashboard">Go to dashboard</a>
        </Button>
      </div>
    </div>
  );
}
