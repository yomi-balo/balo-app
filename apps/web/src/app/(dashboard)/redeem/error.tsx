'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Recoverable error boundary for the redeem surface — nothing was redeemed or charged.
 * Mirrors the promo-codes `error.tsx`: centred destructive glyph + reassurance + a single
 * "Try again" that calls `reset()`.
 */
export default function RedeemError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">This page didn&apos;t load</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        Something went wrong on our side — nothing was redeemed or charged. Try again in a moment.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4">
        Try again
      </Button>
    </div>
  );
}
