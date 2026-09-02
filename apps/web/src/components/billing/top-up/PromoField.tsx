'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Gift, Tag, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { validatePromoAction, type ValidatePromoResult } from '@/lib/credit/actions';
import { formatAudShort } from '@/lib/credit/display-constants';

export interface AppliedPromo {
  code: string;
  minor: number;
}

interface PromoFieldProps {
  readonly promo: AppliedPromo | null;
  readonly onApplied: (promo: AppliedPromo) => void;
  readonly onRemoved: () => void;
}

/** Per-reason copy (design Edge Cases). Never blocks the rest of the form. */
const REASON_COPY: Record<Exclude<ValidatePromoResult, { ok: true }>['reason'], string> = {
  invalid: "That code isn't valid. Check it and try again.",
  scheduled: "That code isn't available yet.",
  expired: 'That code has expired.',
  exhausted: 'That code is no longer available.',
  already_used: "You've already used this code.",
  unauthorized: "You don't have permission to apply a code.",
  error: "We couldn't check that code just now — give it another go.",
};

/**
 * BAL-377 promo field, collapsed to a quiet link (top-up redesign). No codes are advertised
 * on-screen, so an always-open input asks every buyer a question almost none of them have an
 * answer to. Validates the code server-side (Apply-time, read-only); success collapses to a
 * green applied row and the bonus lifts the hero's hours. A failure sets a specific inline
 * error but never blocks the rest of the form. The authoritative grant happens only on
 * successful payment (webhook).
 *
 * ⚠ THE DISCLOSURE TOGGLES, IT DOES NOT UNMOUNT. `value` state lives here and the region is
 * always rendered with the HTML `hidden` attribute, so typing a code, collapsing, and
 * re-expanding preserves it. Closing clears the ERROR but never the value — and a failure
 * force-opens the section and keeps it open, because a collapsed field must never be able to
 * hide a problem.
 */
export function PromoField({ promo, onApplied, onRemoved }: Readonly<PromoFieldProps>) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A failure forces the section open and KEEPS it open.
  useEffect(() => {
    if (error !== null) setOpen(true);
  }, [error]);

  // `autoFocus` only fires on mount, and this input never unmounts — move focus explicitly.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => {
    setOpen(false);
    setError(null);
    // Deliberately NOT clearing `value` (the prototype's close handler does — do not copy it).
  }, []);

  const apply = useCallback(async () => {
    const code = value.trim().toUpperCase();
    if (code.length === 0 || checking) return;
    setChecking(true);
    setError(null);
    try {
      const result = await validatePromoAction(code);
      if (result.ok) {
        onApplied({ code, minor: result.grantMinor });
        setValue('');
      } else {
        setError(REASON_COPY[result.reason]);
      }
    } finally {
      setChecking(false);
    }
  }, [value, checking, onApplied]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply().catch(() => undefined);
      }
    },
    [apply]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value.toUpperCase());
    setError(null);
  }, []);

  const handleApplyClick = useCallback(() => {
    apply().catch(() => undefined);
  }, [apply]);

  if (promo) {
    return (
      <div>
        <div className="text-foreground mb-2.5 text-sm font-semibold">Promo code</div>
        <div className="border-success/40 bg-success/10 flex items-center justify-between gap-2.5 rounded-xl border px-3.5 py-3">
          <span className="text-success inline-flex items-center gap-2 text-sm font-semibold">
            <Gift className="size-4" strokeWidth={2.4} aria-hidden="true" /> {promo.code} applied —{' '}
            {formatAudShort(promo.minor)} bonus credit
          </span>
          <button
            type="button"
            onClick={onRemoved}
            aria-label="Remove promo code"
            className="text-success focus-visible:ring-ring inline-flex hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
          >
            <X className="size-4" strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {!open && (
        <button
          type="button"
          onClick={handleOpen}
          aria-expanded={false}
          aria-controls="promo-disclosure"
          className="text-primary focus-visible:ring-ring relative inline-flex items-center gap-1.5 rounded text-sm font-semibold before:absolute before:-inset-3 before:content-[''] hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
        >
          <Tag className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
          Have a promo code?
        </button>
      )}

      {/* Always rendered (never unmounted) so a typed code survives a collapse/expand. */}
      <div id="promo-disclosure" hidden={!open}>
        <label htmlFor="promo-code" className="text-foreground mb-2.5 block text-sm font-semibold">
          Promo code
        </label>
        <div className="flex gap-2">
          <Input
            id="promo-code"
            ref={inputRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Enter your code"
            autoCapitalize="characters"
            className={cn(
              'flex-1 uppercase placeholder:normal-case',
              error && 'border-destructive'
            )}
            aria-invalid={error !== null}
            aria-describedby={error ? 'promo-error' : undefined}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleApplyClick}
            disabled={value.trim().length === 0 || checking}
          >
            {checking ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking…
              </>
            ) : (
              'Apply'
            )}
          </Button>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close promo field"
            aria-expanded
            aria-controls="promo-disclosure"
            className="text-muted-foreground focus-visible:ring-ring relative inline-flex shrink-0 items-center rounded px-0.5 before:absolute before:-inset-2.5 before:content-[''] hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
          >
            <X className="size-4" strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
        {error && (
          <p id="promo-error" className="text-destructive mt-1.5 text-xs font-medium">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
