'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { ERROR_BOUNDARY_BODY } from '@/components/layout/error-boundary-copy';
import { SectionError } from '@/components/balo/section/section-states';

/** Route-level error boundary for every `(dashboard)` page. Layout throws land in `app/error.tsx`. */
export default function DashboardError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="py-12">
      <SectionError label="this page" onRetry={reset} body={ERROR_BOUNDARY_BODY} />
    </div>
  );
}
