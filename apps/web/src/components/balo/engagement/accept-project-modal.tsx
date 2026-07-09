'use client';

import { Loader2, ThumbsUp } from 'lucide-react';

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

interface AcceptProjectModalProps {
  open: boolean;
  /** Pre-derived body copy (irreversibility + invoice consequence) from the server view. */
  body: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The sticky confirm dialog for the client ACCEPTING the project (BAL-338 / D7). Accept
 * is explicit + irreversible, so the body (server-derived — party names baked, never
 * `@balo/db` on the client) states it can't be un-accepted and that Balo raises the
 * final invoice from here. Blocks close while `pending`; the gradient CTA shows a
 * spinner in flight.
 */
export function AcceptProjectModal({
  open,
  body,
  pending,
  onConfirm,
  onCancel,
}: Readonly<AcceptProjectModalProps>): React.JSX.Element {
  const handleOpenChange = usePendingDialogClose(pending, onCancel);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Accept this project</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Cancel
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
              <ThumbsUp className="size-4" aria-hidden />
            )}
            Accept project
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
