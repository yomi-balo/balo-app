'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { dollarsToMinor } from '@/lib/promo-codes/promo-codes-view';
import { createPromoCode, type CreatePromoCodeActionInput } from '../_actions/create-promo-code';
import {
  MAX_CAP,
  MAX_GRANT_MINOR,
  MIN_CAP,
  MIN_GRANT_MINOR,
  PROMO_CODE_REGEX,
} from '../_actions/promo-code-schema';

/**
 * MintPromoDialog — the create form (BAL-384). Takes the grant in DOLLARS and converts
 * to integer minor units (`dollarsToMinor`) before calling `createPromoCode`; sends the
 * validity window as ISO strings. Client-side validation mirrors the Zod bounds so the
 * admin gets inline feedback; the server remains the source of truth. Toast on
 * success/failure; a duplicate code (`field: 'code'`) maps to a field-level error.
 */

interface MintPromoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface MintForm {
  code: string;
  grantDollars: string;
  cap: string;
  validFrom: string;
  validUntil: string;
}

interface FieldErrors {
  code?: string;
  grant?: string;
  cap?: string;
  validUntil?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a Date as the `YYYY-MM-DD` a `<input type="date">` expects. */
function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Fresh form: code blank, a sensible grant/cap, window = today → +30 days. */
function makeInitialForm(): MintForm {
  const now = new Date();
  return {
    code: '',
    grantDollars: '',
    cap: '',
    validFrom: toDateInputValue(now),
    validUntil: toDateInputValue(new Date(now.getTime() + 30 * DAY_MS)),
  };
}

/** Validate the form; returns field errors and (when clean) the action payload. */
function validateForm(form: MintForm): {
  errors: FieldErrors;
  payload?: CreatePromoCodeActionInput;
} {
  const errors: FieldErrors = {};

  const code = form.code.trim();
  if (!PROMO_CODE_REGEX.test(code.toUpperCase())) {
    errors.code = 'Use 3–32 letters, numbers, or hyphens.';
  }

  const grantMinor = dollarsToMinor(Number.parseFloat(form.grantDollars));
  if (
    !Number.isFinite(grantMinor) ||
    grantMinor < MIN_GRANT_MINOR ||
    grantMinor > MAX_GRANT_MINOR
  ) {
    errors.grant = 'Enter a grant amount in dollars.';
  }

  const cap = Number.parseInt(form.cap, 10);
  if (!Number.isInteger(cap) || cap < MIN_CAP || cap > MAX_CAP) {
    errors.cap = 'Enter a whole-number redemption cap.';
  }

  const from = new Date(form.validFrom);
  const until = new Date(form.validUntil);
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime())) {
    errors.validUntil = 'Choose valid start and end dates.';
  } else if (until <= from) {
    errors.validUntil = 'The end date must be after the start date.';
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  return {
    errors,
    payload: {
      code,
      grantMinor,
      perCodeRedemptionCap: cap,
      validFrom: from.toISOString(),
      validUntil: until.toISOString(),
    },
  };
}

export function MintPromoDialog({
  open,
  onOpenChange,
}: Readonly<MintPromoDialogProps>): React.JSX.Element {
  const [form, setForm] = useState<MintForm>(makeInitialForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isPending, startTransition] = useTransition();

  // Reset to a fresh form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setForm(makeInitialForm());
      setErrors({});
    }
  }, [open]);

  function update(field: keyof MintForm, value: string): void {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const { errors: nextErrors, payload } = validateForm(form);
    setErrors(nextErrors);
    if (payload === undefined) {
      return;
    }
    startTransition(async () => {
      const result = await createPromoCode(payload);
      if (result.success) {
        toast.success(`Promo code ${result.code} minted.`);
        onOpenChange(false);
        return;
      }
      if (result.field === 'code') {
        setErrors({ code: result.error });
        return;
      }
      toast.error(result.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mint a promo code</DialogTitle>
          <DialogDescription>
            Grant a fixed slice of AUD credit each time this code is redeemed, up to a total cap and
            within a validity window.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="promo-code">Code</Label>
            <Input
              id="promo-code"
              value={form.code}
              onChange={(e) => update('code', e.target.value)}
              placeholder="WELCOME50"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
              aria-invalid={errors.code !== undefined}
              aria-describedby="promo-code-hint"
            />
            {errors.code === undefined ? (
              <p id="promo-code-hint" className="text-muted-foreground text-xs">
                3–32 letters, numbers, or hyphens. Stored uppercase; matching is case-insensitive.
              </p>
            ) : (
              <p id="promo-code-hint" className="text-destructive text-xs" role="alert">
                {errors.code}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="promo-grant">Grant per redemption (A$)</Label>
              <Input
                id="promo-grant"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={form.grantDollars}
                onChange={(e) => update('grantDollars', e.target.value)}
                placeholder="50.00"
                aria-invalid={errors.grant !== undefined}
                aria-describedby={errors.grant === undefined ? undefined : 'promo-grant-error'}
              />
              {errors.grant !== undefined && (
                <p id="promo-grant-error" className="text-destructive text-xs" role="alert">
                  {errors.grant}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="promo-cap">Redemption cap</Label>
              <Input
                id="promo-cap"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={form.cap}
                onChange={(e) => update('cap', e.target.value)}
                placeholder="100"
                aria-invalid={errors.cap !== undefined}
                aria-describedby={errors.cap === undefined ? undefined : 'promo-cap-error'}
              />
              {errors.cap !== undefined && (
                <p id="promo-cap-error" className="text-destructive text-xs" role="alert">
                  {errors.cap}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="promo-valid-from">Valid from</Label>
              <Input
                id="promo-valid-from"
                type="date"
                value={form.validFrom}
                onChange={(e) => update('validFrom', e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="promo-valid-until">Valid until</Label>
              <Input
                id="promo-valid-until"
                type="date"
                value={form.validUntil}
                onChange={(e) => update('validUntil', e.target.value)}
                aria-invalid={errors.validUntil !== undefined}
                aria-describedby={
                  errors.validUntil === undefined ? undefined : 'promo-valid-until-error'
                }
              />
              {errors.validUntil !== undefined && (
                <p id="promo-valid-until-error" className="text-destructive text-xs" role="alert">
                  {errors.validUntil}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              {isPending ? 'Minting…' : 'Mint code'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
