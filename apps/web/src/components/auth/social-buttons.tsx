'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

function GoogleLogo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function MicrosoftLogo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

interface SocialButtonsProps {
  disabled?: boolean;
}

export function SocialButtons({ disabled }: SocialButtonsProps): React.JSX.Element {
  const [loadingProvider, setLoadingProvider] = useState<'google' | 'microsoft' | null>(null);

  async function handleSocialAuth(provider: 'google' | 'microsoft'): Promise<void> {
    setLoadingProvider(provider);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log(`[Auth Placeholder] OAuth initiated:`, { provider });
    } finally {
      setLoadingProvider(null);
    }
  }

  const isLoading = loadingProvider !== null;

  return (
    <div className="flex flex-col gap-3">
      <motion.div whileTap={{ scale: 0.98 }}>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className={cn('w-full gap-3 font-medium')}
          disabled={disabled || isLoading}
          onClick={() => handleSocialAuth('google')}
        >
          {loadingProvider === 'google' ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <GoogleLogo className="size-5" />
          )}
          Continue with Google
        </Button>
      </motion.div>
      <motion.div whileTap={{ scale: 0.98 }}>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className={cn('w-full gap-3 font-medium')}
          disabled={disabled || isLoading}
          onClick={() => handleSocialAuth('microsoft')}
        >
          {loadingProvider === 'microsoft' ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <MicrosoftLogo className="size-5" />
          )}
          Continue with Microsoft
        </Button>
      </motion.div>
    </div>
  );
}
