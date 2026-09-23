'use client';

import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { checkUsernameAction } from '../_actions/check-username';

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

interface UsernameInputProps {
  value: string;
  onChange: (value: string) => void;
  expertProfileId: string;
  /** Lets a `<label htmlFor>` outside the component name the input. */
  id?: string;
  /** Merged onto the bordered field shell, e.g. to match the height of neighbouring fields. */
  className?: string;
}

export function UsernameInput({
  value,
  onChange,
  expertProfileId,
  id,
  className,
}: Readonly<UsernameInputProps>): React.JSX.Element {
  const [status, setStatus] = useState<UsernameStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [, startTransition] = useTransition();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCheckedRef = useRef('');
  const prefixId = useId();
  const statusId = useId();

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

  const isRejected = status === 'taken' || status === 'invalid';

  return (
    <div>
      <div
        className={cn(
          'border-input focus-within:border-ring focus-within:ring-ring/50 flex h-9 min-w-0 overflow-hidden rounded-md border bg-[var(--input-bg)] shadow-xs transition-[color,box-shadow] focus-within:ring-[3px]',
          isRejected && 'border-destructive',
          className
        )}
      >
        <span
          id={prefixId}
          className="border-input bg-muted text-muted-foreground flex shrink-0 items-center border-r px-2.5 text-xs whitespace-nowrap sm:px-3 sm:text-[13px]"
        >
          balo.expert/experts/
        </span>
        <Input
          id={id}
          value={value}
          onChange={handleChange}
          placeholder="your-username"
          maxLength={40}
          aria-invalid={isRejected || undefined}
          aria-describedby={`${prefixId} ${statusId}`}
          className="h-full rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
      </div>

      {/* Stays mounted while empty so screen readers announce each status change. */}
      <div id={statusId} aria-live="polite" className="text-xs">
        {status === 'checking' && (
          <p className="text-muted-foreground mt-1.5 flex items-center gap-1.5">
            <Loader2
              className="h-3 w-3 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Checking&hellip;
          </p>
        )}
        {status === 'available' && (
          <p className="text-success-strong mt-1.5 flex items-center gap-1.5">
            <Check className="h-3 w-3" aria-hidden="true" />
            Available
          </p>
        )}
        {isRejected && (
          <p className="text-destructive-strong mt-1.5 flex items-center gap-1.5">
            <X className="h-3 w-3" aria-hidden="true" />
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}
