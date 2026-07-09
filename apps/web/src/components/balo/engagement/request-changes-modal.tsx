'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';

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

interface RequestChangesModalProps {
  open: boolean;
  /** Pre-derived intro (window restarts + who's notified) from the server view. */
  intro: string;
  /** Pre-derived note-field hint (party-named). */
  fieldHint: string;
  pending: boolean;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}

const NOTE_FIELD_ID = 'request-changes-note';

/**
 * The client's "Request changes" dialog (BAL-338 / D7). A note is REQUIRED — the confirm
 * stays disabled until `note.trim()` is non-empty (the Server Action re-validates with a
 * `.min(1)` boundary). Sending it loops the project back to `active` with the note pinned
 * for the expert. Blocks close while `pending`.
 */
export function RequestChangesModal({
  open,
  intro,
  fieldHint,
  pending,
  onConfirm,
  onCancel,
}: Readonly<RequestChangesModalProps>): React.JSX.Element {
  const [note, setNote] = useState('');

  // Reset the field each time the dialog opens.
  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const handleOpenChange = usePendingDialogClose(pending, onCancel);
  const handleConfirm = useCallback((): void => {
    onConfirm(note);
  }, [onConfirm, note]);

  const canSubmit = note.trim() !== '' && !pending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Request changes</DialogTitle>
          <DialogDescription>{intro}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor={NOTE_FIELD_ID}>What needs to change?</Label>
          <Textarea
            id={NOTE_FIELD_ID}
            rows={3}
            maxLength={2000}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What's missing or not working, against the delivery plan"
          />
          <p className="text-muted-foreground text-xs">{fieldHint}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!canSubmit}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <MessageSquare className="size-4" aria-hidden />
            )}
            Send change request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
