'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { UserMenu } from '@/components/layout/user-menu';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { stampAuthGate } from '@/lib/expert-apply/anonymous-draft';
import type { MarketingViewer } from '@/components/marketing/marketing-viewer';

interface ApplyHeaderActionsProps {
  /** `null` for an anonymous visitor (BAL-502 §22 — `/expert/apply` is now genuinely
   * viewable signed-out). `viewer !== null` IS the signed-in signal. */
  viewer: MarketingViewer | null;
}

/**
 * BAL-502 §22.2b — `(apply)/layout.tsx` used to render `<UserMenu />` with no props,
 * which fell back to the literals `'User'`/`'U'` and offered a "Log out" item to a
 * visitor who was never signed in. This component fixes that: a `null` viewer gets a
 * `Log in` control wired to the same unified auth modal the marketing header uses; a
 * real viewer gets the real `UserMenu`.
 */
export function ApplyHeaderActions({
  viewer,
}: Readonly<ApplyHeaderActionsProps>): React.JSX.Element {
  const router = useRouter();
  const authModal = useAuthModal();

  // `router.refresh()` re-runs the (now async) apply layout, which re-reads the
  // session and swaps to the signed-in UserMenu — the same server-driven pattern
  // as the marketing header (`marketing-header.tsx`).
  const handleLogIn = useCallback(() => {
    // BAL-562 — stamp the auth gate BEFORE opening the modal. This control is the
    // ONLY auth affordance on six of the wizard's seven steps, and the post-auth
    // flush refuses any envelope it cannot see a deliberate gate crossing on
    // (WARNING 6's freshness window) — so signing in from here used to discard the
    // visitor's entire in-progress application, silently and with no toast.
    //
    // Storage is the only channel available: this header is rendered by
    // `(apply)/layout.tsx`, outside the wizard's provider, so there is no context to
    // call into. A no-op wherever no anonymous envelope exists — which is every
    // `(apply)` route except the wizard itself. The boolean is not surfaced: a
    // `false` here overwhelmingly means "nothing to stamp" rather than a failure,
    // and a store that cannot be written to never held an envelope to lose.
    stampAuthGate();
    authModal.open({ onSuccess: () => router.refresh() });
  }, [authModal, router]);

  if (viewer === null) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={handleLogIn}>
        Log in
      </Button>
    );
  }

  return <UserMenu userName={viewer.displayName} userInitials={viewer.initials} />;
}
