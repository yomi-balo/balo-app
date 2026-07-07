import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Single copy for BOTH a missing engagement (404) AND an unauthorised viewer — a
 * non-participant cannot distinguish "doesn't exist" from "exists but not yours"
 * (no existence leak).
 */
export default function EngagementNotFound(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <FileQuestion className="text-muted-foreground h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">Engagement not found</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        This engagement doesn&apos;t exist, or you don&apos;t have access to it.
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/projects">Back to projects</Link>
      </Button>
    </div>
  );
}
