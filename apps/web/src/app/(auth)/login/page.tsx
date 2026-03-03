'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthModal } from '@/hooks/use-auth-modal';

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  missing_code: 'Authentication was incomplete. Please try again.',
  session_expired: 'Your session has expired. Please sign in again.',
  access_denied: 'Access was denied by the authentication provider.',
};

const VALID_ERROR_CODES = new Set(Object.keys(ERROR_MESSAGES));

function LoginContent(): React.JSX.Element {
  const { open, isOpen } = useAuthModal();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const errorCode = searchParams.get('error');
    const validatedCode = errorCode && VALID_ERROR_CODES.has(errorCode) ? errorCode : null;
    const errorMessage = validatedCode
      ? ERROR_MESSAGES[validatedCode]
      : errorCode
        ? ERROR_MESSAGES.auth_failed
        : undefined;

    open({ initialError: errorMessage ?? undefined });
  }, [open, searchParams]);

  useEffect(() => {
    if (!isOpen) {
      const timeout = setTimeout(() => router.replace('/'), 150);
      return () => clearTimeout(timeout);
    }
  }, [isOpen, router]);

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
