'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { placeholderOAuth } from './placeholder-actions';

function GoogleIcon({ className }: Readonly<{ className?: string }>): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
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

function MicrosoftIcon({ className }: Readonly<{ className?: string }>): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 21 21"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

interface SocialAuthButtonsProps {
  className?: string;
  disabled?: boolean;
}

export function SocialAuthButtons({
  className,
  disabled = false,
}: Readonly<SocialAuthButtonsProps>): React.JSX.Element {
  const [loadingProvider, setLoadingProvider] = useState<'google' | 'microsoft' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleOAuth = async (provider: 'google' | 'microsoft'): Promise<void> => {
    setError(null);
    setLoadingProvider(provider);
    try {
      await placeholderOAuth(provider);
    } catch {
      setError(
        `Could not connect to ${provider === 'google' ? 'Google' : 'Microsoft'}. Please try again.`
      );
    } finally {
      setLoadingProvider(null);
    }
  };

  return (
    <div className={cn('space-y-3', className)}>
      {error && (
        <p className="text-destructive text-center text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-lg"
          disabled={disabled || loadingProvider !== null}
          onClick={() => handleOAuth('google')}
        >
          {loadingProvider === 'google' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <GoogleIcon className="h-4 w-4" />
          )}
          <span className="ml-2 text-sm font-medium">Google</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-lg"
          disabled={disabled || loadingProvider !== null}
          onClick={() => handleOAuth('microsoft')}
        >
          {loadingProvider === 'microsoft' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MicrosoftIcon className="h-4 w-4" />
          )}
          <span className="ml-2 text-sm font-medium">Microsoft</span>
        </Button>
      </div>
    </div>
  );
}
