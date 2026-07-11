'use client';

import { useCallback, useTransition } from 'react';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';
import { logoutAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { LogOut, Loader2 } from 'lucide-react';

/**
 * BAL-361: the fail-closed onboarding gate traps an authenticated but un-onboarded
 * user on `/onboarding` — this is their only exit besides completing the wizard.
 * Rendered under the wizard so the sign-out Server Action POSTs to `/onboarding`
 * (an allowlisted route), then destroys the session and redirects home.
 * Presentation-only: no toast (sign-out navigates away).
 */
export function OnboardingSignOut(): React.JSX.Element {
  const [isPending, startTransition] = useTransition();

  const handleSignOut = useCallback(() => {
    track(AUTH_EVENTS.LOGOUT_COMPLETED, {});
    // Defer reset so PostHog flushes the event with the user's identity first.
    setTimeout(() => analytics.reset(), 500);
    // Keep the button disabled until the sign-out Server Action resolves + navigates.
    startTransition(() => {
      logoutAction();
    });
  }, []);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleSignOut}
      disabled={isPending}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring gap-2"
    >
      {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
      Not you? Sign out
    </Button>
  );
}
