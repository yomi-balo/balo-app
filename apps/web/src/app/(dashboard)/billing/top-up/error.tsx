'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-377 top-up error boundary — the prototype's reassure/own/retry card. Warm, non-blamey
 * ("this is on our side"); the balance + saved details are safe.
 */
export default function TopUpError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[80vh] items-start justify-center px-4 py-10">
      <div className="border-border bg-card w-full max-w-[540px] rounded-2xl border p-7 shadow-sm">
        <p className="text-foreground text-[15px] leading-relaxed font-medium">
          We couldn&apos;t load the top-up options. Your balance and saved details are safe — this
          is on our side.
        </p>
        <Button type="button" variant="outline" onClick={reset} className="mt-4">
          <RotateCw className="size-4" strokeWidth={2.4} aria-hidden="true" /> Retry
        </Button>
      </div>
    </div>
  );
}
