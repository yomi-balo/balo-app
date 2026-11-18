'use client';

import Link from 'next/link';
import { SectionError } from '@/components/balo/section/section-states';
import { Button } from '@/components/ui/button';

/**
 * The error boundary for the "call now" SMS landing. Nothing is logged here: Sentry's client
 * instrumentation already captures React error boundaries.
 */
export default function CallNowLandingError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-4 py-12">
      <div className="bg-card border-border w-full max-w-md rounded-2xl border p-6">
        <SectionError
          label="this call"
          onRetry={reset}
          body="Nothing is lost — your case and its messages are all still there."
        />
        <div className="mt-4 flex justify-center">
          <Button asChild variant="ghost" className="min-h-11">
            <Link href="/cases">Back to your cases</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
