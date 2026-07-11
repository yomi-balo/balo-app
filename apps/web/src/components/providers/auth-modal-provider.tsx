'use client';

import { createContext, useState, useCallback, useMemo, useRef } from 'react';
import { AuthModal } from '@/components/balo/auth/auth-modal';
import type { AuthStep } from '@/components/balo/auth/unified-auth-form';

/**
 * BAL-361: why the modal last closed. `close()` (dismiss path) sets `'dismissed'`;
 * `handleAuthSuccess()` (success path) sets `'success'`. The `/login` and `/signup`
 * pages read this to decide whether to bounce home — a genuine dismiss returns to
 * `/`, a success lets the auth step's own `router.push('/onboarding')` win (no timer).
 */
export type CloseReason = 'dismissed' | 'success';

export interface AuthModalContextValue {
  isOpen: boolean;
  defaultStep: AuthStep;
  initialError: string | null;
  /** Reason the modal last closed, or null while open / before any close. */
  closeReason: CloseReason | null;
  open: (options?: {
    defaultStep?: AuthStep;
    onSuccess?: () => void;
    initialError?: string;
  }) => void;
  close: () => void;
  handleAuthSuccess: () => void;
  /** @deprecated Use open({ defaultStep: 'email' }) */
  openLogin: (onSuccess?: () => void) => void;
  /** @deprecated Use open({ defaultStep: 'signup' }) */
  openSignup: (onSuccess?: () => void) => void;
}

export const AuthModalContext = createContext<AuthModalContextValue | null>(null);

interface AuthModalProviderProps {
  children: React.ReactNode;
}

export function AuthModalProvider({
  children,
}: Readonly<AuthModalProviderProps>): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [defaultStep, setDefaultStep] = useState<AuthStep>('email');
  const [initialError, setInitialError] = useState<string | null>(null);
  const [closeReason, setCloseReason] = useState<CloseReason | null>(null);
  const onSuccessRef = useRef<(() => void) | undefined>(undefined);

  const open = useCallback(
    (options?: { defaultStep?: AuthStep; onSuccess?: () => void; initialError?: string }) => {
      onSuccessRef.current = options?.onSuccess;
      setDefaultStep(options?.defaultStep ?? 'email');
      setInitialError(options?.initialError ?? null);
      // Reset so a re-open starts clean — a prior 'dismissed'/'success' must not
      // linger into the newly-opened modal's next close.
      setCloseReason(null);
      setIsOpen(true);
    },
    []
  );

  const openLogin = useCallback(
    (onSuccess?: () => void) => {
      open({ defaultStep: 'email', onSuccess });
    },
    [open]
  );

  const openSignup = useCallback(
    (onSuccess?: () => void) => {
      open({ defaultStep: 'signup', onSuccess });
    },
    [open]
  );

  const close = useCallback(() => {
    // Dismiss path (wired to Dialog/Sheet onOpenChange). Both state writes batch,
    // so the pages' effect observes the fresh reason alongside isOpen === false.
    setCloseReason('dismissed');
    setIsOpen(false);
    onSuccessRef.current = undefined;
  }, []);

  const handleAuthSuccess = useCallback(() => {
    // Success path (form onSuccess). Batches with isOpen so the pages never see a
    // stale reason — the auth step's own /onboarding navigation wins.
    setCloseReason('success');
    setIsOpen(false);
    onSuccessRef.current?.();
    onSuccessRef.current = undefined;
  }, []);

  const contextValue = useMemo<AuthModalContextValue>(
    () => ({
      isOpen,
      defaultStep,
      initialError,
      closeReason,
      open,
      openLogin,
      openSignup,
      close,
      handleAuthSuccess,
    }),
    [
      isOpen,
      defaultStep,
      initialError,
      closeReason,
      open,
      openLogin,
      openSignup,
      close,
      handleAuthSuccess,
    ]
  );

  return (
    <AuthModalContext.Provider value={contextValue}>
      {children}
      <AuthModal defaultStep={defaultStep} initialError={initialError} />
    </AuthModalContext.Provider>
  );
}
