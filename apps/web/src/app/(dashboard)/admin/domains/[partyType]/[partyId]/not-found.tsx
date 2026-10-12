import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Shown for a bad party type, a non-uuid id, or a company or agency that no longer exists. The
 * action returns to Lookup, the page staff arrive from.
 */
export default function AdminPartyDomainsNotFound(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <FileQuestion className="text-muted-foreground h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">We couldn&apos;t find that party</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        It may have been removed, or the link may be wrong.
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/admin/lookup">Back to Lookup</Link>
      </Button>
    </div>
  );
}
