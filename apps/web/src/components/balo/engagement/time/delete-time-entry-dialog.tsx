'use client';

import { useCallback } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { TimeEntryView } from '@/lib/engagement/time-view';
import { removeTimeEntryAction } from '@/app/(dashboard)/engagements/[id]/_actions/remove-time-entry';
import { useEngagementLifecycleAction } from '../use-engagement-lifecycle-action';

interface DeleteTimeEntryDialogProps {
  engagementId: string;
  /** The entry to delete; null keeps the dialog closed. */
  entry: TimeEntryView | null;
  clientCompanyName: string;
  onClose: () => void;
}

/** Confirms removing one of the author's own time entries. Keep stays available mid-save. */
export function DeleteTimeEntryDialog({
  engagementId,
  entry,
  clientCompanyName,
  onClose,
}: Readonly<DeleteTimeEntryDialogProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (!next) onClose();
    },
    [onClose]
  );
  const handleDelete = useCallback((): void => {
    if (entry === null) return;
    run(removeTimeEntryAction({ engagementId, entryId: entry.id }), 'Time entry deleted', onClose);
  }, [entry, run, engagementId, onClose]);

  return (
    <Dialog open={entry !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this time entry?</DialogTitle>
          <DialogDescription>
            {entry === null
              ? ''
              : `${entry.hoursLabel} on ${entry.workedOnLabel} — "${entry.note}". It comes off the milestone's hours, and ${clientCompanyName} no longer sees it.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep entry
          </Button>
          <Button type="button" variant="destructive" onClick={handleDelete} disabled={isPending}>
            {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Delete entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
