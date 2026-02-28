'use client';

import { useEffect } from 'react';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { Logo } from '@/components/layout/logo';

export default function SignupPage(): React.JSX.Element {
  const { openSignup } = useAuthModal();

  useEffect(() => {
    openSignup();
  }, [openSignup]);

  return (
    <div className="from-background to-muted/30 flex min-h-screen items-center justify-center bg-gradient-to-b">
      <div className="text-center">
        <Logo className="mx-auto mb-6 justify-center" />
        <p className="text-muted-foreground text-sm">Redirecting to sign up...</p>
      </div>
    </div>
  );
}
