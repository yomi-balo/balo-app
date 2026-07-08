'use client';

import { Check, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { usePendingDialogClose } from './use-engagement-lifecycle-action';

interface RequestCompletionModalProps {
  open: boolean;
  /** Pre-derived body copy (window + plan-lock + invoice) from the server view. */
  modalBody: string;
  clientCompanyName: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirm dialog for marking the whole project complete (BAL-334 / D4). Body is
 * pre-derived server-side (`AUTO_ACCEPT_DAYS`, party names baked in) so the client
 * never touches `@balo/db`. Blocks close while `pending`; the gradient CTA shows a
 * spinner in flight.
 */
export function RequestCompletionModal({
  open,
  modalBody,
  clientCompanyName,
  pending,
  onConfirm,
  onCancel,
}: Readonly<RequestCompletionModalProps>): React.JSX.Element {
  const handleOpenChange = usePendingDialogClose(pending, onCancel);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Mark project complete</DialogTitle>
          <DialogDescription>{modalBody}</DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Not yet
          </Button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={cn(
              'focus-visible:ring-ring inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-70',
              PROPOSAL_CTA_GRADIENT_CLASS
            )}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Check className="size-4" aria-hidden />
            )}
            Send for {clientCompanyName}&apos;s review
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
