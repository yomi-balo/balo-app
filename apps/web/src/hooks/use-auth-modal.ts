'use client';

import { useAuthModalContext } from '@/components/providers/auth-modal-provider';

export function useAuthModal(): {
  openLogin: (returnContext?: Record<string, unknown>) => void;
  openSignup: (returnContext?: Record<string, unknown>) => void;
  close: () => void;
} {
  const { openLogin, openSignup, close } = useAuthModalContext();
  return { openLogin, openSignup, close };
}
