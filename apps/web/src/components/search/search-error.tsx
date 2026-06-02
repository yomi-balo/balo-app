'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';

/**
 * Inline graceful fallback rendered INSIDE the page try/catch when the search seam
 * throws (distinct from the route-level `error.tsx`, which catches render throws).
 * "Try again" re-navigates the current URL, which re-runs the RSC fetch.
 */
export function SearchError(): React.JSX.Element {
  const router = useRouter();

  const handleRetry = useCallback(() => {
    router.refresh();
  }, [router]);

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">We couldn&apos;t load experts</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
        Something went wrong fetching search results. This is usually temporary.
      </p>
      <button
        type="button"
        onClick={handleRetry}
        className="border-border text-foreground hover:bg-muted focus-visible:ring-ring mt-4 inline-flex h-10 items-center justify-center rounded-lg border px-5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        Try again
      </button>
    </div>
  );
}
