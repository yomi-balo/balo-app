import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The `notFound()` boundary for the admin-only oversight surface. A non-admin
 * viewer gets the same generic 404 as a truly missing route — they cannot
 * distinguish "this page doesn't exist" from "exists but not for you" (no
 * existence leak), and it stays inside the dashboard chrome.
 */
export default function EngagementsNotFound(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <FileQuestion className="text-muted-foreground h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">Page not found</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        This page doesn&apos;t exist, or you don&apos;t have access to it.
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
