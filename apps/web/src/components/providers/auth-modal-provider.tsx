'use client';

import { createContext, useContext, useCallback, useState, type ReactNode } from 'react';

export type AuthView = 'sign-in' | 'sign-up' | 'forgot-password';

interface AuthModalState {
  isOpen: boolean;
  view: AuthView;
  returnContext?: Record<string, unknown>;
}

interface AuthModalContextValue {
  state: AuthModalState;
  openLogin: (returnContext?: Record<string, unknown>) => void;
  openSignup: (returnContext?: Record<string, unknown>) => void;
  close: () => void;
  setView: (view: AuthView) => void;
}

const AuthModalContext = createContext<AuthModalContextValue | null>(null);

export function AuthModalProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthModalState>({
    isOpen: false,
    view: 'sign-in',
  });

  const openLogin = useCallback((returnContext?: Record<string, unknown>) => {
    setState({ isOpen: true, view: 'sign-in', returnContext });
  }, []);

  const openSignup = useCallback((returnContext?: Record<string, unknown>) => {
    setState({ isOpen: true, view: 'sign-up', returnContext });
  }, []);

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const setView = useCallback((view: AuthView) => {
    setState((prev) => ({ ...prev, view }));
  }, []);

  return (
    <AuthModalContext value={{ state, openLogin, openSignup, close, setView }}>
      {children}
    </AuthModalContext>
  );
}

export function useAuthModalContext(): AuthModalContextValue {
  const context = useContext(AuthModalContext);
  if (!context) {
    throw new Error('useAuthModalContext must be used within AuthModalProvider');
  }
  return context;
}
