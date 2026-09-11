import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-549 — genuinely needed: a staff member follows a queue deep link for an application that
 * has since been hard-deleted, or mistypes an id. Copy is scoped to this detail route and
 * distinct from `admin/applications/not-found.tsx`, `admin/catalogue/not-found.tsx` and
 * `admin/not-found.tsx` (jscpd flagged a byte-identical clone across siblings in BAL-534's fix
 * round — do not repeat it).
 *
 * The action returns to `/admin/applications`, unlike the list-level and catalogue boundaries
 * (`/dashboard`) — from a detail route there IS a guaranteed parent inside the admin subtree.
 */
export default function AdminApplicationReviewNotFound(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <FileQuestion className="text-muted-foreground h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">
        {/* pending-MJ */}
        We couldn&apos;t find that application
      </h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        {/* pending-MJ */}
        It may have been removed, or the link may be wrong.
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/admin/applications">
          {/* pending-MJ */}
          Back to applications
        </Link>
      </Button>
    </div>
  );
}
