'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthModal } from '@/hooks/use-auth-modal';

export default function LoginPage(): React.JSX.Element {
  const { openLogin, isOpen } = useAuthModal();
  const router = useRouter();

  useEffect(() => {
    openLogin();
  }, [openLogin]);

  // Redirect home if the user closes the modal (prevents dead state)
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
