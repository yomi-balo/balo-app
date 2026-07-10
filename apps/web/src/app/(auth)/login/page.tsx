'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthModal } from '@/hooks/use-auth-modal';

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  missing_code: 'Authentication was incomplete. Please try again.',
  session_expired: 'Your session has expired. Please sign in again.',
  access_denied: 'Access was denied by the authentication provider.',
  account_suspended: 'Your account has been suspended. Please contact support.',
  account_deleted: 'Your account is no longer active. Please contact support.',
  // BAL-360: a live account already owns this email under a different identity and
  // the incoming profile was unverified — non-leaky copy (never reveal the method).
  account_exists:
    'An account with this email already exists. Please sign in with your original method.',
};

const VALID_ERROR_CODES = new Set(Object.keys(ERROR_MESSAGES));

/**
 * Resolve the user-facing auth error copy for a `?error=` query value. A known
 * code maps to its message; any other non-empty code falls back to the generic
 * failure copy; an absent code surfaces no error.
 */
function resolveErrorMessage(errorCode: string | null): string | undefined {
  if (errorCode && VALID_ERROR_CODES.has(errorCode)) {
    return ERROR_MESSAGES[errorCode];
  }
  if (errorCode) {
    return ERROR_MESSAGES.auth_failed;
  }
  return undefined;
}

function LoginContent(): React.JSX.Element {
  const { open, isOpen } = useAuthModal();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const errorMessage = resolveErrorMessage(searchParams.get('error'));
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
