'use client';

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
import { usePendingDialogClose } from './use-engagement-lifecycle-action';

interface WithdrawCompletionModalProps {
  open: boolean;
  clientCompanyName: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirm dialog for withdrawing a pending completion request (BAL-334 / D4) —
 * takes the project back out of the client's review to active. Blocks close while
 * `pending`; the confirm button shows a spinner in flight.
 */
export function WithdrawCompletionModal({
  open,
  clientCompanyName,
  pending,
  onConfirm,
  onCancel,
}: Readonly<WithdrawCompletionModalProps>): React.JSX.Element {
  const handleOpenChange = usePendingDialogClose(pending, onCancel);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Withdraw completion request</DialogTitle>
          <DialogDescription>
            The project goes back to active and {clientCompanyName}&apos;s review is cancelled —{' '}
            {clientCompanyName} and the Balo team will be notified. Mark it complete again when
            you&apos;re ready.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Keep it under review
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="size-4" aria-hidden />
            )}
            Withdraw request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
