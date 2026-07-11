'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthModal } from '@/hooks/use-auth-modal';

export default function SignUpPage(): React.JSX.Element {
  const { openSignup, isOpen, closeReason } = useAuthModal();
  const router = useRouter();
  const hasOpenedRef = useRef(false);

  useEffect(() => {
    openSignup();
  }, [openSignup]);

  // BAL-361: bounce home ONLY on a genuine dismiss, and only after the modal
  // actually opened on this page (guards stale provider state carried across
  // navigations). On success the auth step already fired router.push('/onboarding')
  // — do nothing here so it wins. No timer: this is deterministic regardless of
  // how slowly /onboarding compiles.
  useEffect(() => {
    if (isOpen) {
      hasOpenedRef.current = true;
      return;
    }
    if (!hasOpenedRef.current) return; // never opened here yet — ignore stale closed state
    if (closeReason === 'success') return; // success handled by the step's navigation
    router.replace('/');
  }, [isOpen, closeReason, router]);

  return (
    <div className="text-muted-foreground text-center text-sm">
      <p>Preparing sign up...</p>
    </div>
  );
}
