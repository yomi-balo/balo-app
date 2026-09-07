'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-534 fix round F6 — the `error.tsx` boundary for admin **pages** under `/admin/*` (today
 * `admin/page.tsx`; tomorrow BAL-548/551's pages, which will not each carry one). CLAUDE.md
 * requires an error boundary per new route segment; before this file, only `catalogue/` had one.
 *
 * ⚠ THIS DOES NOT GUARD `admin/layout.tsx`. Next does not route a segment's own `layout.tsx`
 * throw to that segment's `error.tsx` — a segment's error boundary wraps that segment's
 * CHILDREN slot, and the layout sits outside it, same asymmetry as `admin/not-found.tsx`
 * documents for `notFound()`. A throw inside `AdminLayout` bubbles past this file to whatever
 * boundary sits above `(dashboard)`. So this file renders for nothing today — `admin/layout.tsx`
 * has no I/O to throw, and `admin/page.tsx` is a bare `redirect()` with no I/O either — and it
 * becomes live only once BAL-548 ships a first sibling `admin/<x>/page.tsx` that can actually
 * fail. Do not read this as guarding the layout.
 *
 * Admin-scoped copy, distinct from `catalogue/error.tsx` (own file, out of scope): the retry
 * stays a single "Try again" calling `reset()`, matching the sibling boundary's shape.
 *
 * ⚠ pending-MJ — the copy below is flagged for MJ's sign-off queue (called out in the PR body).
 */
export default function AdminError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">
        {/* pending-MJ */}
        This admin page hit a snag
      </h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        {/* pending-MJ */}
        Nothing was changed. Try again, or head back to the catalogue.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4">
        {/* pending-MJ */}
        Try again
      </Button>
    </div>
  );
}
