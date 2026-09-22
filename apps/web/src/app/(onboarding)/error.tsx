'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingFrame } from './onboarding/_components/onboarding-frame';

/**
 * Route error boundary for the whole `(onboarding)` group (BAL-348). The group had
 * none; this covers the new join-result landing surface and every onboarding step
 * with a branded, in-shell retry — the frame keeps the sign-out exit reachable, since the
 * fail-closed gate would otherwise leave an erroring user with no way out. Unhandled client render errors are already captured
 * by Sentry client instrumentation, so this boundary does not log (matching the
 * sibling `projects` / `engagements` boundaries).
 */
export default function OnboardingError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return (
    <OnboardingFrame>
      <div className="flex w-full flex-col items-center justify-center py-8 text-center">
        <div className="bg-destructive/10 mb-4 rounded-xl p-4">
          <AlertCircle className="text-destructive h-8 w-8" aria-hidden="true" />
        </div>
        <h1 className="text-foreground text-lg font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground mt-1 max-w-sm text-sm">
          We couldn&apos;t load this step. This might be a temporary issue.
        </p>
        <Button onClick={reset} variant="outline" className="mt-4">
          Try again
        </Button>
      </div>
    </OnboardingFrame>
  );
}
