'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { checkUsernameAction } from '../_actions/check-username';

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

interface UsernameInputProps {
  value: string;
  onChange: (value: string) => void;
  expertProfileId: string;
}

export function UsernameInput({
  value,
  onChange,
  expertProfileId,
}: Readonly<UsernameInputProps>): React.JSX.Element {
  const [status, setStatus] = useState<UsernameStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [, startTransition] = useTransition();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCheckedRef = useRef('');

  const checkAvailability = useCallback(
    (username: string) => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      // Reset for empty or too short
      if (!username || username.length < 3) {
        setStatus('idle');
        setErrorMessage('');
        return;
      }

      setStatus('checking');

      debounceTimer.current = setTimeout(() => {
        lastCheckedRef.current = username;
        startTransition(async () => {
          try {
            const result = await checkUsernameAction({ username });
            // Only update if this is still the latest check
            if (lastCheckedRef.current !== username) return;

            if (result.error) {
              setStatus('invalid');
              setErrorMessage(result.error);
            } else if (result.available) {
              setStatus('available');
              setErrorMessage('');
            } else {
              setStatus('taken');
              setErrorMessage('Username already taken');
            }
          } catch {
            if (lastCheckedRef.current === username) {
              setStatus('idle');
            }
          }
        });
      }, 300);
    },
    [startTransition]
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Normalize: lowercase, strip invalid chars
      const normalized = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      onChange(normalized);
      checkAvailability(normalized);
    },
    [onChange, checkAvailability]
  );

  // If initial value is provided and non-empty, mark as available on mount
  useEffect(() => {
    if (value && value.length >= 3 && expertProfileId) {
      checkAvailability(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expertProfileId]);

  return (
    <div>
      <div className="flex">
        <span className="border-input bg-muted text-muted-foreground inline-flex h-9 items-center rounded-l-md border border-r-0 px-3 text-xs sm:text-sm">
          balo.expert/experts/
        </span>
        <Input
          value={value}
          onChange={handleChange}
          placeholder="your-username"
          className="rounded-l-none"
          maxLength={40}
        />
      </div>

      {/* Status feedback */}
      {status === 'checking' && (
        <p className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking...
        </p>
      )}
      {status === 'available' && (
        <p className="text-success mt-1.5 flex items-center gap-1.5 text-xs">
          <Check className="h-3 w-3" />
          balo.expert/experts/{value} is available
        </p>
      )}
      {status === 'taken' && (
        <p className={cn('text-destructive mt-1.5 flex items-center gap-1.5 text-xs')}>
          <X className="h-3 w-3" />
          {errorMessage}
        </p>
      )}
      {status === 'invalid' && (
        <p className="text-destructive mt-1.5 flex items-center gap-1.5 text-xs">
          <X className="h-3 w-3" />
          {errorMessage}
        </p>
      )}
    </div>
  );
}
