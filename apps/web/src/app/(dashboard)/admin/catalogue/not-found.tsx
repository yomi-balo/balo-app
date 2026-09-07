import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-534 — the `notFound()` boundary for `/admin/catalogue`. A non-staff viewer gets the same
 * generic 404 as a truly missing route (no existence leak).
 *
 * ⚠ BAL-534 fix round F7 — this used to copy `promo-codes/not-found.tsx` (and, transitively,
 * `admin/not-found.tsx`) verbatim, which jscpd flagged as a byte-identical clone. Copy is now
 * catalogue-scoped and distinct from both siblings; the action still returns to `/dashboard`
 * (unchanged) since this boundary can be reached from a catalogue sub-route with no guaranteed
 * admin-subtree context to return to.
 *
 * ⚠ pending-MJ — the copy below is flagged for MJ's sign-off queue (called out in the PR body).
 */
export default function AdminCatalogueNotFound(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <FileQuestion className="text-muted-foreground h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">
        {/* pending-MJ */}
        We couldn&apos;t find that catalogue entry
      </h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        {/* pending-MJ */}
        The destination may not be live yet, or you don&apos;t have access to it.
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/dashboard">
          {/* pending-MJ */}
          Back to dashboard
        </Link>
      </Button>
    </div>
  );
}
