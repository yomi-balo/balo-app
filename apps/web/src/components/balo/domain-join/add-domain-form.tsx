'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateDomainInput } from '@/lib/domain-input';
import { addPartyDomain } from '@/app/(dashboard)/settings/team/_actions/add-domain';
import { cn } from '@/lib/utils';

interface AddDomainFormProps {
  partyType: 'company' | 'agency';
  partyId: string;
}

/**
 * The ONE emphasised action on a domain surface (BAL-347): a validated, lowercased
 * domain input + the gradient ShimmerButton. Client-side validation (shared with the
 * server via `@/lib/domain-input`) blocks obviously-bad input before the round-trip;
 * server business errors (already-claimed, freemail, duplicate) surface INLINE (not a
 * toast). A successful add toasts and shows the "recorded in your audit log" note.
 */
export function AddDomainForm({
  partyType,
  partyId,
}: Readonly<AddDomainFormProps>): React.JSX.Element {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(async (): Promise<void> => {
    const validation = validateDomainInput(value);
    if (!validation.ok) {
      setError(validation.error);
      setJustAdded(false);
      return;
    }
    setError(null);
    setIsBusy(true);
    try {
      const result = await addPartyDomain({ partyType, partyId, domain: validation.domain });
      if (result.success) {
        toast.success('Domain added');
        setValue('');
        setJustAdded(true);
        inputRef.current?.focus();
      } else {
        setError(result.error);
        setJustAdded(false);
      }
    } finally {
      setIsBusy(false);
    }
  }, [value, partyType, partyId]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    setValue(event.target.value.toLowerCase());
    setError(null);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    },
    [submit]
  );

  const handleClick = useCallback((): void => {
    void submit();
  }, [submit]);

  const hasError = error !== null;

  return (
    <div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[220px] flex-1 space-y-1.5">
          <Label htmlFor={inputId} className="text-muted-foreground text-xs font-semibold">
            Add a domain
          </Label>
          <Input
            id={inputId}
            ref={inputRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="acme.com"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            disabled={isBusy}
            aria-invalid={hasError}
            aria-describedby={hasError ? errorId : undefined}
            className={cn(
              'h-11',
              hasError && 'border-destructive focus-visible:ring-destructive/30'
            )}
          />
          <p className="text-muted-foreground text-xs">Domains are stored in lowercase.</p>
        </div>
        <div className="pt-[26px]">
          <ShimmerButton
            type="button"
            onClick={handleClick}
            disabled={isBusy}
            aria-label="Add domain"
            className="h-11 rounded-lg px-5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            shimmerColor="rgba(255, 255, 255, 0.18)"
            background="var(--primary)"
          >
            {isBusy ? (
              <span className="flex items-center gap-2" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Adding…
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add domain
              </span>
            )}
          </ShimmerButton>
        </div>
      </div>

      {hasError && (
        <div
          id={errorId}
          role="alert"
          className="border-destructive/25 bg-destructive/10 text-destructive mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {justAdded && !hasError && (
        <p
          role="status"
          className="text-success mt-3 flex items-center gap-1.5 text-sm font-medium"
        >
          <Check className="h-4 w-4" aria-hidden="true" />
          Domain added and recorded in your audit log.
        </p>
      )}
    </div>
  );
}
