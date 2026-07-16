'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
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
import type { PromoCodeAdminRow } from '@/lib/promo-codes/promo-codes-view';
import { updatePromoCap } from '../_actions/update-promo-cap';
import { MAX_CAP, MIN_CAP } from '../_actions/promo-code-schema';

/**
 * EditCapDialog — change a code's total redemption cap (BAL-384). A cap below the current
 * `redeemed_count` is rejected by the server with a friendly message
 * (`CapBelowRedeemedCountError` → "Cap can't be lower than the {n} redemptions already
 * made"); the dialog also pre-checks client-side to save a round trip. Toast on success;
 * the failure message renders inline so the admin can adjust.
 */

interface EditCapDialogProps {
  /** The code being edited, or null when the dialog is closed. */
  row: PromoCodeAdminRow | null;
  onOpenChange: (open: boolean) => void;
}

interface EditCapFormProps {
  row: PromoCodeAdminRow;
  onOpenChange: (open: boolean) => void;
}

function EditCapForm({ row, onOpenChange }: Readonly<EditCapFormProps>): React.JSX.Element {
  const [cap, setCap] = useState<string>(String(row.perCodeRedemptionCap));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const newCap = Number.parseInt(cap, 10);
    if (!Number.isInteger(newCap) || newCap < MIN_CAP || newCap > MAX_CAP) {
      setError('Enter a whole-number cap.');
      return;
    }
    if (newCap < row.redeemedCount) {
      setError(`Cap can't be lower than the ${row.redeemedCount} redemptions already made.`);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updatePromoCap({ id: row.id, newCap });
      if (result.success) {
        toast.success(`Cap updated to ${result.newCap}.`);
        onOpenChange(false);
        return;
      }
      // A non-validation server failure (code gone, DB error): surface inline so the admin
      // sees it in context, AND toast to match how mint/deactivate report their failures.
      // The below-redeemed-count validation case is caught client-side above and never
      // reaches here, so it stays inline-only (no double toast).
      setError(result.error);
      toast.error(result.error);
    });
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Edit redemption cap</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{row.code}</span> has {row.redeemedCount} of{' '}
          {row.perCodeRedemptionCap} redeemed. The new cap can&apos;t drop below what&apos;s already
          been redeemed.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="promo-new-cap">Total redemption cap</Label>
          <Input
            id="promo-new-cap"
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            value={cap}
            onChange={(e) => {
              setCap(e.target.value);
              if (error !== null) {
                setError(null);
              }
            }}
            aria-invalid={error !== null}
            autoFocus
          />
          {error !== null && (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          )}
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
            {isPending ? 'Saving…' : 'Save cap'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function EditCapDialog({
  row,
  onOpenChange,
}: Readonly<EditCapDialogProps>): React.JSX.Element {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      {row !== null && <EditCapForm key={row.id} row={row} onOpenChange={onOpenChange} />}
    </Dialog>
  );
}
