'use client';

import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function EngagementWorkspaceError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">This engagement didn&apos;t load</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        We couldn&apos;t load this delivery workspace. This might be a temporary issue.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/projects">Back to projects</Link>
        </Button>
      </div>
    </div>
  );
}
