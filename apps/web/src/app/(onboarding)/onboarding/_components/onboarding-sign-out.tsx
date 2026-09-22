'use client';

import { useCallback, useTransition } from 'react';
import { useLogout } from '@/components/layout/use-logout';
import { Button } from '@/components/ui/button';
import { LogOut, Loader2 } from 'lucide-react';

/**
 * BAL-361: the fail-closed onboarding gate traps an authenticated but un-onboarded
 * user on `/onboarding` — this is their only exit besides completing the wizard.
 * Rendered in the onboarding header so the sign-out Server Action POSTs to `/onboarding`
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
      onClick={handleSignOut}
      disabled={isPending}
      className="text-muted-foreground hover:text-foreground h-11 rounded-[10px] has-[>svg]:px-2.5 md:has-[>svg]:px-3.5"
    >
      {isPending ? <Loader2 className="animate-spin" /> : <LogOut />}
      {/* The mobile header has room for the verb only. */}
      <span>
        <span className="hidden md:inline">Not you?</span> Sign out
      </span>
    </Button>
  );
}
