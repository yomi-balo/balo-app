'use client';

import { useCallback } from 'react';
import { Loader2, Trash2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface RemoveMilestoneModalProps {
  open: boolean;
  milestoneTitle: string;
  /** Escalates the copy to danger tone (removing already-delivered work). */
  isCompleted: boolean;
  clientCompanyName: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The remove-milestone confirm dialog (BAL-333 / D3, design L1876–1910). The tone
 * ESCALATES to danger when the milestone is already `completed` — removing it erases
 * delivered work from the plan the client can see. This IS the required extra confirm
 * for completed milestones (Decision F); the server permits the remove either way and
 * the scope-change notification is the compensating transparency. Blocks close while
 * `pending` (mirrors `RevertMilestoneModal`); the destructive CTA shows a spinner in
 * flight.
 */
export function RemoveMilestoneModal({
  open,
  milestoneTitle,
  isCompleted,
  clientCompanyName,
  pending,
  onConfirm,
  onCancel,
}: Readonly<RemoveMilestoneModalProps>): React.JSX.Element {
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
          <DialogTitle>Remove milestone</DialogTitle>
          <DialogDescription>
            {isCompleted ? (
              <>
                <strong className="text-destructive font-semibold">
                  {milestoneTitle} is already complete
                </strong>{' '}
                — removing it erases delivered work from the plan {clientCompanyName} can see.{' '}
                {clientCompanyName} will be notified of the change.
              </>
            ) : (
              <>
                <strong className="text-foreground font-semibold">{milestoneTitle}</strong> comes
                off the delivery plan. {clientCompanyName} will be notified of the change.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Keep it
          </Button>
          <Button variant="destructive" type="button" onClick={onConfirm} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-4" aria-hidden />
            )}
            Remove milestone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
