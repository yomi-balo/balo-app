'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthModal } from '@/hooks/use-auth-modal';
import {
  ProjectRequestPanel,
  type ProjectRequestSeed,
} from '@/components/balo/project-request/panel';
import {
  forgetPendingHomeProject,
  rememberPendingHomeProject,
} from '@/lib/marketing/pending-home-project';

export interface HomeProjectPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly seed?: ProjectRequestSeed;
  readonly resumeDraft: boolean;
  readonly isLoggedIn: boolean;
}

/**
 * BAL-582 §4 (D1) — the home hero's context-free `ProjectRequestPanel` mount, `entryPoint`
 * `'home'`, no expert. The ONLY home file that calls `useAuthModal` / `useRouter().refresh` —
 * kept out of `hero-search.tsx` (and every test that never opens the panel) by that file's lazy
 * `dynamic()` host.
 *
 * Signed out, `onAuthRequired` (`requestSignIn`) remembers the pending-intent marker and stacks
 * the auth modal over the still-mounted drawer (precedent `booking-flow-dialog.tsx:760-782`:
 * an app-root provider, so Radix layers keep the drawer mounted and undismissed). On success,
 * `router.refresh()` re-resolves `isLoggedIn` server-side WITHOUT resetting this client tree
 * (`expert-profile-client.tsx`, the booking dialog rely on the same fact) — the drawer, its step
 * and its draft survive, and `onAuthRequired` becomes `undefined` once `isLoggedIn` flips, so
 * Submit / a document attach just work on the next click. There is no auto-submit.
 */
export function HomeProjectPanel({
  open,
  onClose,
  seed,
  resumeDraft,
  isLoggedIn,
}: Readonly<HomeProjectPanelProps>): React.JSX.Element {
  const authModal = useAuthModal();
  const router = useRouter();
  // True only while an auth-modal open was requested BY THIS PANEL. A stale `closeReason` left
  // over from a HEADER-opened modal must never be read as this flow's own dismiss/success —
  // `auth-modal-provider.tsx:54-56` resets `closeReason` on every fresh `open()`, but this ref is
  // what keeps an unrelated close from being misread by the effect below.
  const heroAuthRef = useRef(false);

  const requestSignIn = useCallback(() => {
    rememberPendingHomeProject();
    heroAuthRef.current = true;
    authModal.open({ onSuccess: () => router.refresh() });
  }, [authModal, router]);

  // A DISMISSED auth modal (backed out without signing in) clears the marker, so an unrelated
  // sign-in later doesn't silently bounce the visitor back to `/`. `'success'` keeps it — a
  // brand-new sign-up still needs it once onboarding completes, as does the OAuth round trip
  // (the page unloads before `close()` ever runs).
  useEffect(() => {
    if (!heroAuthRef.current || authModal.isOpen) return;
    heroAuthRef.current = false;
    if (authModal.closeReason === 'dismissed') forgetPendingHomeProject();
  }, [authModal.isOpen, authModal.closeReason]);

  return (
    <ProjectRequestPanel
      open={open}
      onClose={onClose}
      entryPoint="home"
      seed={seed}
      resumeDraft={resumeDraft}
      onAuthRequired={isLoggedIn ? undefined : requestSignIn}
    />
  );
}
