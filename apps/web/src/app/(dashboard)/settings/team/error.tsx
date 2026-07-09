'use client';

import { SectionError } from '@/components/balo/domain-join/section-states';

/**
 * Route error boundary for the company Members & access surface (BAL-347). Renders the
 * shared section-error visual with a retry that resets the segment. Unhandled client
 * render errors are already captured by Sentry client instrumentation, so this boundary
 * does not log (matching the sibling `engagements` / `projects` boundaries).
 */
export default function MembersAccessError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl py-8">
      <SectionError label="members & access" onRetry={reset} />
    </div>
  );
}
