'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';

interface CompleteMilestoneModalProps {
  open: boolean;
  milestoneTitle: string;
  clientCompanyName: string;
  pending: boolean;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}

const NOTE_FIELD_ID = 'complete-milestone-note';

/**
 * The delivery-note capture dialog (BAL-332 / D2). Captures an OPTIONAL plain-text
 * delivery note (link-friendly, no minimum — an empty note is valid → completes with
 * no note). Blocks close while `pending` (`onOpenChange` no-ops; the close button is
 * hidden). The gradient "Mark complete" stays enabled and shows a spinner in flight.
 */
export function CompleteMilestoneModal({
  open,
  milestoneTitle,
  clientCompanyName,
  pending,
  onConfirm,
  onCancel,
}: Readonly<CompleteMilestoneModalProps>): React.JSX.Element {
  const [note, setNote] = useState('');

  // Reset the field each time the dialog opens (fresh per milestone).
  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending) return; // no close mid-flight
      if (!next) onCancel();
    },
    [pending, onCancel]
  );

  const handleConfirm = useCallback((): void => {
    onConfirm(note);
  }, [onConfirm, note]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Mark milestone complete</DialogTitle>
          <DialogDescription>
            <strong className="text-foreground font-semibold">{milestoneTitle}</strong> —{' '}
            {clientCompanyName} and the Balo team will be notified.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor={NOTE_FIELD_ID}>What was delivered? (optional)</Label>
          <p className="text-muted-foreground text-xs leading-relaxed">
            A link and a line goes a long way — this is what {clientCompanyName} reviews against.
          </p>
          <Textarea
            id={NOTE_FIELD_ID}
            rows={3}
            maxLength={4000}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Link to the deliverable, a summary of what changed…"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={handleConfirm}
            className={cn(
              'focus-visible:ring-ring inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none',
              PROPOSAL_CTA_GRADIENT_CLASS
            )}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Check className="size-4" aria-hidden />
            )}
            Mark complete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
