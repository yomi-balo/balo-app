'use client';

import { useCallback } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface RevertMilestoneModalProps {
  open: boolean;
  milestoneTitle: string;
  clientCompanyName: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The revert confirm dialog (BAL-332 / D2) — reverts are never silent, so moving a
 * completed milestone back to in progress goes behind an explicit confirm. No input.
 * Blocks close while `pending` (the close button is hidden and Escape no-ops).
 */
export function RevertMilestoneModal({
  open,
  milestoneTitle,
  clientCompanyName,
  pending,
  onConfirm,
  onCancel,
}: Readonly<RevertMilestoneModalProps>): React.JSX.Element {
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending) return; // no close mid-flight
      if (!next) onCancel();
    },
    [pending, onCancel]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Move back to in progress</DialogTitle>
          <DialogDescription>
            <strong className="text-foreground font-semibold">{milestoneTitle}</strong> goes back to
            in progress and its completion record is cleared. {clientCompanyName} and the Balo team
            will be notified — reverts are never silent.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="default" type="button" onClick={onConfirm} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="size-4" aria-hidden />
            )}
            Move back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
