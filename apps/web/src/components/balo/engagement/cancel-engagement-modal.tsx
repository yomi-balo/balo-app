'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ban, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { usePendingDialogClose } from './use-engagement-lifecycle-action';

interface CancelEngagementModalProps {
  open: boolean;
  pending: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

const REASON_FIELD_ID = 'cancel-engagement-reason';

/**
 * The danger dialog for cancelling an engagement (BAL-334 / D4, admin only). A reason
 * is REQUIRED — the solid-destructive confirm stays disabled until `reason.trim()` is
 * non-empty (the Server Action re-validates). Party-generic copy (the admin strip
 * carries no party strings). Blocks close while `pending`.
 */
export function CancelEngagementModal({
  open,
  pending,
  onConfirm,
  onCancel,
}: Readonly<CancelEngagementModalProps>): React.JSX.Element {
  const [reason, setReason] = useState('');

  // Reset the field each time the dialog opens.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const handleOpenChange = usePendingDialogClose(pending, onCancel);

  const handleConfirm = useCallback((): void => {
    onConfirm(reason);
  }, [onConfirm, reason]);

  const canSubmit = reason.trim() !== '' && !pending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Cancel this engagement</DialogTitle>
          <DialogDescription>
            This ends delivery permanently — the client and the delivering expert are both notified,
            and the workspace locks. A reason is required; it&apos;s recorded and shown on the
            cancelled engagement.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor={REASON_FIELD_ID}>Reason</Label>
          <Textarea
            id={REASON_FIELD_ID}
            rows={3}
            maxLength={2000}
            value={reason}
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this engagement is being cancelled"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Keep engagement
          </Button>
          <Button variant="destructive" type="button" onClick={handleConfirm} disabled={!canSubmit}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Ban className="size-4" aria-hidden />
            )}
            Cancel engagement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
