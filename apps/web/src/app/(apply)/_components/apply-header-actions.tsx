'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { UserMenu } from '@/components/layout/user-menu';
import { useAuthModal } from '@/hooks/use-auth-modal';
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
