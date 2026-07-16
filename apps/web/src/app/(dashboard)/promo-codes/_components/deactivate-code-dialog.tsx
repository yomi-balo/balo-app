'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Ban } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { PromoCodeAdminRow } from '@/lib/promo-codes/promo-codes-view';
import { deactivatePromoCode } from '../_actions/deactivate-promo-code';

/**
 * DeactivateCodeDialog — a destructive confirm gate for turning a code off (BAL-384).
 * Deactivation is one-way (no reactivation this ticket) and idempotent server-side.
 * Toast on success/failure; closes on success.
 */

interface DeactivateCodeDialogProps {
  /** The code being deactivated, or null when the dialog is closed. */
  row: PromoCodeAdminRow | null;
  onOpenChange: (open: boolean) => void;
}

export function DeactivateCodeDialog({
  row,
  onOpenChange,
}: Readonly<DeactivateCodeDialogProps>): React.JSX.Element {
  const [isPending, startTransition] = useTransition();

  function handleConfirm(): void {
    if (row === null) {
      return;
    }
    const { id, code } = row;
    startTransition(async () => {
      const result = await deactivatePromoCode({ id });
      if (result.success) {
        toast.success(`${code} deactivated.`);
        onOpenChange(false);
        return;
      }
      toast.error(result.error);
    });
  }

  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      {row !== null && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate this code?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{row.code}</span> will stop being redeemable right away.
              This can&apos;t be undone — mint a replacement code if you need it back.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleConfirm}
              disabled={isPending}
            >
              <Ban className="h-4 w-4" aria-hidden="true" />
              {isPending ? 'Deactivating…' : 'Deactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
