'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ChangeOrderComposerError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">The change didn&apos;t load</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        We couldn&apos;t open the change composer. This might be a temporary issue, and nothing you
        sent has been affected.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href={`/engagements/${id}`}>Back to the project</Link>
        </Button>
      </div>
    </div>
  );
}
