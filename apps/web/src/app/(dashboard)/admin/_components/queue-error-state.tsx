'use client';

import { AlertCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * BAL-548 / ADR-1055 — the Home page's IN-PAGE error state (§B.7.5). Rendered directly by
 * `page.tsx` on a caught read failure, NOT delegated to `admin/error.tsx` — that boundary is
 * shared with `catalogue/` and its copy ("head back to the catalogue") does not fit here. The
 * segment's `error.tsx` remains the last-resort boundary for anything this component itself
 * cannot catch (a render-time throw).
 *
 * `client` only for the `Retry` button's `router.refresh()` — everything else is static.
 */
export function QueueErrorState(): React.JSX.Element {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">Home didn&apos;t load</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        {/* pending-MJ */}
        Something went wrong on our side — nothing was changed, and every alert is still recorded.
        Retry in a moment.
      </p>
      <Button onClick={() => router.refresh()} variant="outline" className="mt-4">
        Retry
      </Button>
    </div>
  );
}
