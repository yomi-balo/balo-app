'use client';

import { useEffect } from 'react';
import { useAuthModal } from '@/components/auth/auth-modal-provider';
import { Logo } from '@/components/layout/logo';

export default function SignupPage(): React.JSX.Element {
  const { openSignup, isOpen } = useAuthModal();

  useEffect(() => {
    // Auto-open modal on mount if not already open
    if (!isOpen) {
      openSignup();
    }
  }, [isOpen, openSignup]);

  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center">
      {/* Subtle gradient background */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="bg-primary/5 absolute top-1/4 left-1/3 h-96 w-96 rounded-full blur-3xl" />
        <div className="absolute right-1/4 bottom-1/3 h-80 w-80 rounded-full bg-purple-500/5 blur-3xl" />
      </div>

      <div className="flex flex-col items-center gap-4">
        <Logo />
        <p className="text-muted-foreground text-sm">Connect with expert technology consultants</p>
      </div>
    </div>
  );
}
