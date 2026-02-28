'use client';

import { useEffect } from 'react';
import { useAuthModal } from '@/hooks/use-auth-modal';

export default function SignUpPage(): React.JSX.Element {
  const { openSignup } = useAuthModal();

  useEffect(() => {
    openSignup();
  }, [openSignup]);

  return (
    <div className="text-muted-foreground text-center text-sm">
      <p>Preparing sign up...</p>
    </div>
  );
}
