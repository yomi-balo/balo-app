'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ApplicationReviewError({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by Next.js error boundary contract
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">Something went wrong</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        We couldn&apos;t load your application. This might be a temporary issue.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4">
        Try again
      </Button>
    </div>
  );
}
