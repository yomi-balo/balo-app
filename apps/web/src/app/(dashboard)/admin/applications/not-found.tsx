import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-549 — the `notFound()` boundary for `/admin/applications`. A non-staff viewer gets the
 * same generic 404 as a truly missing route (no existence leak).
 *
 * Copy is applications-scoped and distinct from `admin/catalogue/not-found.tsx` and
 * `admin/not-found.tsx` (jscpd flagged a byte-identical clone across these in BAL-534's fix
 * round — do not repeat it).
 */
export default function AdminApplicationsNotFound(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <FileQuestion className="text-muted-foreground h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">
        {/* pending-MJ */}
        We couldn&apos;t find the applications queue
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
