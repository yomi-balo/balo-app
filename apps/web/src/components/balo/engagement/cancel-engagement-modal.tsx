'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Info, Loader2 } from 'lucide-react';

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
import { track, ENGAGEMENT_EVENTS } from '@/lib/analytics';
import { cancelEngagementAction } from '@/app/(dashboard)/engagements/[id]/_actions/cancel-engagement';
import { useEngagementLifecycleAction } from './use-engagement-lifecycle-action';

/** The dialog's pre-derived copy (the view's `cancelDialog`). */
export interface CancelDialogCopy {
  body: string;
  reasonHint: string;
  /** Shown only while the project is in the client's review. */
  reviewNote: string | null;
}

interface CancelEngagementModalProps {
  open: boolean;
  engagementId: string;
  deliveryStatus: 'active' | 'pending_acceptance';
  dialog: CancelDialogCopy;
  onClose: () => void;
}

const REASON_FIELD_ID = 'cancel-engagement-reason';

/**
 * The cancel-project dialog (Balo staff, via the "More actions" menu). It states what
 * happens, asks for a reason that both parties will see, and makes keeping the project the
 * easy path: "Keep the project" is the primary button and takes initial focus, while
 * "Cancel project" is a quiet destructive-text button that stays disabled until the reason
 * is non-blank. Keep, Escape and an overlay click all close it and are tracked as a keep;
 * none of them is ever blocked by a save in flight. Closing it while a cancel is in flight
 * is not a keep (the cancel still completes), so it is not tracked.
 */
export function CancelEngagementModal({
  open,
  engagementId,
  deliveryStatus,
  dialog,
  onClose,
}: Readonly<CancelEngagementModalProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [reason, setReason] = useState('');
  const keepRef = useRef<HTMLButtonElement>(null);

  // Reset the field each time the dialog opens.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const keep = useCallback(
    (via: 'button' | 'dismiss'): void => {
      if (!isPending) {
        track(ENGAGEMENT_EVENTS.CANCEL_DIALOG_KEPT, {
          engagement_id: engagementId,
          delivery_status: deliveryStatus,
          via,
        });
      }
      onClose();
    },
    [isPending, engagementId, deliveryStatus, onClose]
  );
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (!next) keep('dismiss');
    },
    [keep]
  );
  const handleKeep = useCallback((): void => keep('button'), [keep]);
  const focusKeep = useCallback((event: Event): void => {
    event.preventDefault();
    keepRef.current?.focus();
  }, []);
  const handleReason = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => setReason(event.target.value),
    []
  );
  const handleConfirm = useCallback((): void => {
    run(
      cancelEngagementAction({ engagementId, reason: reason.trim() }),
      'Project cancelled',
      onClose
    );
  }, [run, engagementId, reason, onClose]);

  const canConfirm = reason.trim() !== '' && !isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent onOpenAutoFocus={focusKeep}>
        <DialogHeader>
          <DialogTitle>Cancel this project?</DialogTitle>
          <DialogDescription>{dialog.body}</DialogDescription>
        </DialogHeader>

        {dialog.reviewNote !== null && (
          <div className="border-violet/25 bg-violet/10 text-foreground flex items-start gap-2 rounded-xl border p-3 text-sm">
            <Info className="text-violet mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{dialog.reviewNote}</p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={REASON_FIELD_ID}>Reason</Label>
          <p className="text-muted-foreground text-xs">{dialog.reasonHint}</p>
          <Textarea
            id={REASON_FIELD_ID}
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={handleReason}
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="text-destructive-strong hover:text-destructive-strong"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Cancel project
          </Button>
          <Button ref={keepRef} type="button" onClick={handleKeep}>
            Keep the project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
