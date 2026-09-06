import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-534 — the `notFound()` boundary for admin **pages** under `/admin/*` (today
 * `admin/page.tsx`; tomorrow BAL-548/551's pages, which will not each carry one).
 *
 * ⚠ THIS DOES NOT SERVE `admin/layout.tsx`'s `notFound()`. A segment's `not-found` module wraps
 * that segment's CHILDREN slot, and the layout sits outside it — so a `notFound()` thrown from
 * the layout bubbles past `(dashboard)` (which has no group-level boundary) to Next's built-in
 * 404, not this component. That is still a real 404 with no existence leak — a non-staff viewer
 * cannot distinguish "no route" from "not for you" — which is the property that matters. Do not
 * "fix" this by adding a `(dashboard)/not-found.tsx`; that would change the 404 UI for every
 * dashboard route that has no local boundary (see the plan's Open Question Q1).
 *
 * ⚠ BAL-534 fix round F7 — this used to copy `promo-codes/not-found.tsx` verbatim, which put it
 * in a byte-identical jscpd clone with `catalogue/not-found.tsx` (own file, out of scope). Copy
 * is now admin-scoped and distinct, and the action routes back into the admin catalogue ("Back
 * to admin" → `/admin/catalogue`) rather than `/dashboard` — a viewer already inside `/admin/*`
 * is better served landing back on the one real admin surface than leaving the subtree entirely.
 *
 * ⚠ pending-MJ — the copy below is flagged for MJ's sign-off queue (called out in the PR body).
 */
export default function AdminNotFound(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <FileQuestion className="text-muted-foreground h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">
        {/* pending-MJ */}
        That admin page doesn&apos;t exist
      </h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        {/* pending-MJ */}
        It may have moved, or you might not have access. The admin catalogue lists every surface
        that does exist.
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/admin/catalogue">
          {/* pending-MJ */}
          Back to admin
        </Link>
      </Button>
    </div>
  );
}
