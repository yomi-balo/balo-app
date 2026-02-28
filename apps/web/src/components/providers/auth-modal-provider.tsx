'use client';

import { createContext, useState, useCallback, useMemo, useRef } from 'react';
import { AuthModal } from '@/components/balo/auth/auth-modal';

export type AuthView = 'sign-in' | 'sign-up' | 'forgot-password';

export interface AuthModalContextValue {
  isOpen: boolean;
  view: AuthView;
  openLogin: (onSuccess?: () => void) => void;
  openSignup: (onSuccess?: () => void) => void;
  close: () => void;
  setView: (view: AuthView) => void;
  handleAuthSuccess: () => void;
}

export const AuthModalContext = createContext<AuthModalContextValue | null>(null);

interface AuthModalProviderProps {
  children: React.ReactNode;
}

export function AuthModalProvider({ children }: AuthModalProviderProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<AuthView>('sign-in');
  const onSuccessRef = useRef<(() => void) | undefined>(undefined);

  const openLogin = useCallback((onSuccess?: () => void) => {
    onSuccessRef.current = onSuccess;
    setView('sign-in');
    setIsOpen(true);
  }, []);

  const openSignup = useCallback((onSuccess?: () => void) => {
    onSuccessRef.current = onSuccess;
    setView('sign-up');
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    onSuccessRef.current = undefined;
  }, []);

  const handleAuthSuccess = useCallback(() => {
    setIsOpen(false);
    onSuccessRef.current?.();
    onSuccessRef.current = undefined;
  }, []);

  const handleSetView = useCallback((v: AuthView) => setView(v), []);

  const contextValue = useMemo<AuthModalContextValue>(
    () => ({
      isOpen,
      view,
      openLogin,
      openSignup,
      close,
      setView: handleSetView,
      handleAuthSuccess,
    }),
    [isOpen, view, openLogin, openSignup, close, handleSetView, handleAuthSuccess]
  );

  return (
    <AuthModalContext.Provider value={contextValue}>
      {children}
      <AuthModal />
    </AuthModalContext.Provider>
  );
}
