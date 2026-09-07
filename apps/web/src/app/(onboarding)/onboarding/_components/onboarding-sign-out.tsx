'use client';

import { useCallback, useTransition } from 'react';
import { useLogout } from '@/components/layout/use-logout';
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
  const logout = useLogout();

  // BAL-529 §C — ONE client sign-out sequence for the whole app. `useLogout` owns the analytics
  // event, the deferred reset, the SetupIntent-binding clear and the Server Action call; this
  // path adds only the transition that keeps the button disabled until the navigation lands.
  const handleSignOut = useCallback(() => {
    startTransition(() => {
      logout();
    });
  }, [logout]);

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
