'use client';

import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { oauthAction } from '@/lib/auth/auth-actions';

interface SocialAuthButtonsProps {
  isLoading?: boolean;
}

function GoogleIcon(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function MicrosoftIcon(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
      <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

interface OAuthButtonProps {
  icon: React.ReactNode;
  label: string;
  provider: 'google' | 'microsoft';
  disabled?: boolean;
}

function OAuthButton({ icon, label, provider, disabled }: OAuthButtonProps): React.JSX.Element {
  return (
    <motion.div whileTap={{ scale: 0.98 }}>
      <Button
        variant="outline"
        className="h-11 w-full gap-3 text-sm font-medium"
        disabled={disabled}
        onClick={() => {
          void oauthAction(provider);
        }}
      >
        {icon}
        {label}
      </Button>
    </motion.div>
  );
}

export function SocialAuthButtons({ isLoading }: SocialAuthButtonsProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <OAuthButton
        icon={<GoogleIcon />}
        label="Continue with Google"
        provider="google"
        disabled={isLoading}
      />
      <OAuthButton
        icon={<MicrosoftIcon />}
        label="Continue with Microsoft"
        provider="microsoft"
        disabled={isLoading}
      />
    </div>
  );
}
