'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { resolveErrorMessage } from '@/lib/auth/auth-error-copy';

function LoginContent(): React.JSX.Element {
  const { open, isOpen, closeReason } = useAuthModal();
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasOpenedRef = useRef(false);

  useEffect(() => {
    const errorMessage = resolveErrorMessage(searchParams.get('error'));
    open({ initialError: errorMessage ?? undefined });
  }, [open, searchParams]);

  // BAL-361: bounce home ONLY on a genuine dismiss, and only after the modal
  // actually opened here. On success the auth step already fired
  // router.push('/onboarding') — do nothing so it wins. No timer.
  useEffect(() => {
    if (isOpen) {
      hasOpenedRef.current = true;
      return;
    }
    if (!hasOpenedRef.current) return;
    if (closeReason === 'success') return;
    router.replace('/');
  }, [isOpen, closeReason, router]);

  return (
    <div className="text-muted-foreground text-center text-sm">
      <p>Preparing sign in...</p>
    </div>
  );
}

export default function LoginPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground text-center text-sm">
          <p>Preparing sign in...</p>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
