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
import { Checkbox } from '@/components/ui/checkbox';
import { usePendingDialogClose } from './use-engagement-lifecycle-action';

interface RequestChangesModalProps {
  open: boolean;
  /** Pre-derived intro (window restarts + who's notified) from the server view. */
  intro: string;
  /** Pre-derived note-field hint (party-named). */
  fieldHint: string;
  /** The live milestones the client may tag; empty hides the picker. */
  milestoneOptions: readonly { id: string; title: string }[];
  /** Helper line under the picker (party-named). */
  milestoneHelper: string;
  /** Values the form starts from on each open (an unsent draft survives a failed send). */
  initialNote: string;
  initialMilestoneIds: readonly string[];
  pending: boolean;
  onConfirm: (note: string, milestoneIds: string[]) => void;
  onCancel: () => void;
}

const NOTE_FIELD_ID = 'request-changes-note';

/**
 * The client's "Request changes" dialog (BAL-338 / D7). A note is REQUIRED — the confirm
 * stays disabled until `note.trim()` is non-empty (the Server Action re-validates with a
 * `.min(1)` boundary). Sending it loops the project back to `active` with the note pinned
 * for the expert; any milestones the client ticks are tagged on the round and the
 * completed ones reopen. Blocks close while `pending`.
 */
export function RequestChangesModal({
  open,
  intro,
  fieldHint,
  milestoneOptions,
  milestoneHelper,
  initialNote,
  initialMilestoneIds,
  pending,
  onConfirm,
  onCancel,
}: Readonly<RequestChangesModalProps>): React.JSX.Element {
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);

  // Start from the held draft each time the dialog opens.
  useEffect(() => {
    if (open) {
      setNote(initialNote);
      setPicked(initialMilestoneIds);
    }
  }, [open, initialNote, initialMilestoneIds]);

  const togglePicked = useCallback((id: string, checked: boolean): void => {
    setPicked((current) =>
      checked ? [...current.filter((x) => x !== id), id] : current.filter((x) => x !== id)
    );
  }, []);

  const handleOpenChange = usePendingDialogClose(pending, onCancel);
  const handleConfirm = useCallback((): void => {
    // Send in plan order, whatever order the boxes were ticked in.
    onConfirm(
      note,
      milestoneOptions.filter((option) => picked.includes(option.id)).map((option) => option.id)
    );
  }, [onConfirm, note, picked, milestoneOptions]);

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

        {milestoneOptions.length > 0 && (
          <fieldset className="space-y-1.5" disabled={pending}>
            <legend className="text-sm leading-none font-medium">
              Is this about particular milestones?{' '}
              <span className="text-muted-foreground font-normal">Optional</span>
            </legend>
            <div className="max-h-56 space-y-1.5 overflow-y-auto pt-1.5">
              {milestoneOptions.map((option) => {
                const id = `request-changes-milestone-${option.id}`;
                return (
                  <div
                    key={option.id}
                    className="border-border hover:bg-muted/50 flex items-center gap-2.5 rounded-lg border px-3 py-2"
                  >
                    <Checkbox
                      id={id}
                      checked={picked.includes(option.id)}
                      onCheckedChange={(checked) => togglePicked(option.id, checked === true)}
                    />
                    <Label htmlFor={id} className="flex-1 cursor-pointer text-sm font-medium">
                      {option.title}
                    </Label>
                  </div>
                );
              })}
            </div>
            <p className="text-muted-foreground text-xs">{milestoneHelper}</p>
          </fieldset>
        )}

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
