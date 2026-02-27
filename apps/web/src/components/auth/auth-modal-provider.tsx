'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export type AuthView = 'sign-in' | 'sign-up' | 'forgot-password';

interface AuthModalContextValue {
  isOpen: boolean;
  view: AuthView;
  openLogin: () => void;
  openSignup: () => void;
  close: () => void;
  setView: (view: AuthView) => void;
}

const AuthModalContext = createContext<AuthModalContextValue | null>(null);

export function AuthModalProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<AuthView>('sign-in');

  const openLogin = useCallback(() => {
    setView('sign-in');
    setIsOpen(true);
  }, []);

  const openSignup = useCallback(() => {
    setView('sign-up');
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    // Reset view after close animation completes
    setTimeout(() => setView('sign-in'), 200);
  }, []);

  const value = useMemo(
    () => ({ isOpen, view, openLogin, openSignup, close, setView }),
    [isOpen, view, openLogin, openSignup, close]
  );

  return <AuthModalContext value={value}>{children}</AuthModalContext>;
}

export function useAuthModal(): AuthModalContextValue {
  const context = useContext(AuthModalContext);
  if (!context) {
    throw new Error('useAuthModal must be used within an AuthModalProvider');
  }
  return context;
}
