'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthModal } from '@/hooks/use-auth-modal';

export default function SignUpPage(): React.JSX.Element {
  const { openSignup, isOpen } = useAuthModal();
  const router = useRouter();

  useEffect(() => {
    openSignup();
  }, [openSignup]);

  // Redirect home if the user closes the modal (prevents dead state)
  useEffect(() => {
    if (!isOpen) {
      const timeout = setTimeout(() => router.replace('/'), 150);
      return () => clearTimeout(timeout);
    }
  }, [isOpen, router]);

  return (
    <div className="text-muted-foreground text-center text-sm">
      <p>Preparing sign up...</p>
    </div>
  );
}
