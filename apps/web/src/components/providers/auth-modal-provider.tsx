'use client';

import { createContext, useState, useCallback, useMemo, useRef } from 'react';
import { AuthModal } from '@/components/balo/auth/auth-modal';
import type { AuthStep } from '@/components/balo/auth/unified-auth-form';

export interface AuthModalContextValue {
  isOpen: boolean;
  defaultStep: AuthStep;
  initialError: string | null;
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
  const onSuccessRef = useRef<(() => void) | undefined>(undefined);

  const open = useCallback(
    (options?: { defaultStep?: AuthStep; onSuccess?: () => void; initialError?: string }) => {
      onSuccessRef.current = options?.onSuccess;
      setDefaultStep(options?.defaultStep ?? 'email');
      setInitialError(options?.initialError ?? null);
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
    setIsOpen(false);
    onSuccessRef.current = undefined;
  }, []);

  const handleAuthSuccess = useCallback(() => {
    setIsOpen(false);
    onSuccessRef.current?.();
    onSuccessRef.current = undefined;
  }, []);

  const contextValue = useMemo<AuthModalContextValue>(
    () => ({
      isOpen,
      defaultStep,
      initialError,
      open,
      openLogin,
      openSignup,
      close,
      handleAuthSuccess,
    }),
    [isOpen, defaultStep, initialError, open, openLogin, openSignup, close, handleAuthSuccess]
  );

  return (
    <AuthModalContext.Provider value={contextValue}>
      {children}
      <AuthModal defaultStep={defaultStep} initialError={initialError} />
    </AuthModalContext.Provider>
  );
}
