'use client';

import { useCallback, useId, useState, useTransition } from 'react';
import { Loader2, Send, Shield, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { assignRequestOwnerAction } from '@/app/(dashboard)/projects/[requestId]/_actions/assign-request-owner';
import { createInternalNoteAction } from '@/app/(dashboard)/projects/[requestId]/_actions/create-internal-note';
import { deleteInternalNoteAction } from '@/app/(dashboard)/projects/[requestId]/_actions/delete-internal-note';
import type { BaloPanelView, InternalNoteView } from '@/lib/project-request/load-balo-panel';
import { formatRelativeTime } from '@/lib/format/relative-time';
import { InitialsAvatar } from '@/components/balo/conversation/initials-avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { RequestCard } from './request-card';

interface BaloPanelProps {
  requestId: string;
  view: BaloPanelView;
}

/** Radix `Select` rejects an empty-string item value — this sentinel stands for "no owner". */
const UNASSIGNED = 'unassigned';

/**
 * The "Balo" staff panel (BAL-541) — who owns this request, and the staff-internal notebook.
 * Structure mapped 1:1 from `request-close.jsx:1035-1192` (BaloPanel). Renders on LIVE and
 * CLOSED requests alike (D5) — the shell decides WHERE this mounts, never whether it exists.
 *
 * Local state is seeded from the server-resolved `view` and updated from each action's return
 * (the `AdminFeeOverridePanel` `setBps(res.newBps)` shape) — no client-side re-fetch.
 */
export function BaloPanel({ requestId, view }: Readonly<BaloPanelProps>): React.JSX.Element {
  const [owner, setOwner] = useState(view.owner);
  const [notes, setNotes] = useState(view.notes);
  const [draft, setDraft] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isOwnerPending, startOwnerTransition] = useTransition();
  const [isNotePending, startNoteTransition] = useTransition();
  const [isDeletePending, startDeleteTransition] = useTransition();
  const errorId = useId();

  // The current owner may have been demoted out of the staff roster (D7) — prepend them so the
  // select still renders a value instead of falling back to a blank/placeholder row.
  const staffOptions =
    owner !== null && !view.staff.some((s) => s.userId === owner.userId)
      ? [{ userId: owner.userId, name: owner.name }, ...view.staff]
      : view.staff;

  const handleOwnerChange = useCallback(
    (nextValue: string): void => {
      const ownerUserId = nextValue === UNASSIGNED ? null : nextValue;
      startOwnerTransition(async () => {
        const res = await assignRequestOwnerAction({ requestId, ownerUserId });
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        setOwner(res.owner);
        toast.success(
          res.owner === null ? 'Owner cleared' : `${res.owner.name} is now the Balo owner`
        );
        if (res.changed) {
          track(PROJECT_EVENTS.REQUEST_OWNER_ASSIGNED, {
            request_id: res.analytics.requestId,
            previous_owner_present: res.analytics.previousOwnerPresent,
            self_assigned: res.analytics.selfAssigned,
            cleared: res.analytics.cleared,
          });
        }
      });
    },
    [requestId]
  );

  const handleAddNote = useCallback((): void => {
    const body = draft.trim();
    if (body.length < 3 || isNotePending) return;
    setNoteError(null);
    startNoteTransition(async () => {
      const res = await createInternalNoteAction({ requestId, body });
      if (!res.success) {
        setNoteError(res.error);
        toast.error(res.error);
        return;
      }
      setNotes((prev) => [res.note, ...prev]);
      setDraft('');
      toast.success('Note added');
      track(PROJECT_EVENTS.INTERNAL_NOTE_CREATED, {
        entity_type: res.analytics.entityType,
        entity_id: res.analytics.entityId,
      });
    });
  }, [draft, isNotePending, requestId]);

  const handleDeleteNote = useCallback((): void => {
    const noteId = pendingDeleteId;
    if (noteId === null) return;
    startDeleteTransition(async () => {
      const res = await deleteInternalNoteAction({ requestId, noteId });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      setNotes((prev) => prev.filter((n) => n.id !== res.noteId));
      setPendingDeleteId(null);
      toast.success('Note deleted');
    });
  }, [pendingDeleteId, requestId]);

  return (
    <RequestCard className="border-info/30 overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Shield className="text-info h-3.5 w-3.5" aria-hidden="true" />
        <span className="text-info text-sm font-bold">Balo</span>
        <span className="text-muted-foreground ml-auto text-xs">Staff only</span>
      </div>

      <div className="border-b px-4 py-3.5">
        <p className="text-muted-foreground mb-1.5 text-xs font-semibold">Owner</p>
        <Select
          value={owner?.userId ?? UNASSIGNED}
          onValueChange={handleOwnerChange}
          disabled={!view.canAssignOwner || isOwnerPending}
        >
          <SelectTrigger aria-label="Balo owner" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
            {staffOptions.map((s) => (
              <SelectItem key={s.userId} value={s.userId}>
                {`${s.name} @ Balo`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {view.canWriteNotes && (
        <div className="px-4 py-3.5">
          <p className="text-muted-foreground mb-2.5 text-xs font-semibold">Notes</p>
          {notes.length === 0 ? (
            <div className="bg-muted rounded-xl px-3 py-4.5 text-center">
              <p className="text-foreground text-sm font-bold">No notes yet</p>
              <p className="text-muted-foreground mt-1 text-xs">
                What should the next person at Balo know about this request?
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {notes.map((note) => (
                <NoteRow key={note.id} note={note} onRequestDelete={setPendingDeleteId} />
              ))}
            </div>
          )}

          <div className="mt-3 flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setNoteError(null);
              }}
              rows={2}
              placeholder="Add a note for the team"
              disabled={isNotePending}
              aria-label="Add a note for the team"
              aria-invalid={noteError !== null}
              aria-describedby={noteError === null ? undefined : errorId}
              className="flex-1 resize-none"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleAddNote}
              disabled={draft.trim().length < 3 || isNotePending}
              className="min-h-11"
            >
              {isNotePending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
              Add
            </Button>
          </div>
          {noteError !== null && (
            <p id={errorId} role="alert" className="text-destructive mt-1.5 text-xs">
              {noteError}
            </p>
          )}
        </div>
      )}

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>
              This can&apos;t be undone. The note will no longer be visible to the team.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDeleteNote();
              }}
              disabled={isDeletePending}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {isDeletePending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </RequestCard>
  );
}

/** One note row: avatar, author + relative time, delete trigger (author/`DELETE_ANY_INTERNAL_NOTE`
 *  only), body. */
function NoteRow({
  note,
  onRequestDelete,
}: Readonly<{
  note: InternalNoteView;
  onRequestDelete: (noteId: string) => void;
}>): React.JSX.Element {
  return (
    <div className="flex gap-2.5">
      <InitialsAvatar initials={note.authorInitials} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold">{`${note.authorName} @ Balo`}</span>
          <span className="text-muted-foreground text-[11px]">
            {formatRelativeTime(note.createdAtIso)}
          </span>
          {note.canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="relative ml-auto after:absolute after:-inset-2.5 after:content-['']"
              aria-label="Delete note"
              onClick={() => onRequestDelete(note.id)}
            >
              <Trash2 className="text-muted-foreground h-3 w-3" aria-hidden="true" />
            </Button>
          )}
        </div>
        <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap">{note.body}</p>
      </div>
    </div>
  );
}
