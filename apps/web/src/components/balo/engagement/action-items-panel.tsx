'use client';

import { useCallback, useEffect, useState, useOptimistic, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ActionItemNodeView, ActionItemsPanelView } from '@/lib/engagement/action-items-view';
import { createActionItemAction } from '@/app/(dashboard)/engagements/[id]/_actions/create-action-item';
import { updateActionItemAction } from '@/app/(dashboard)/engagements/[id]/_actions/update-action-item';
import { assignActionItemAction } from '@/app/(dashboard)/engagements/[id]/_actions/assign-action-item';
import { setActionItemStatusAction } from '@/app/(dashboard)/engagements/[id]/_actions/set-action-item-status';
import { removeActionItemAction } from '@/app/(dashboard)/engagements/[id]/_actions/remove-action-item';
import type { ActionItemActionResult } from '@/app/(dashboard)/engagements/[id]/_actions/action-item-action-shared';

type AssigneeParty = 'client' | 'expert' | null;

interface ActionItemsPanelProps {
  view: ActionItemsPanelView;
}

/** Optimistic patch instructions applied by the reducer (reconciled by `router.refresh()`). */
type PanelAction =
  | { kind: 'add'; node: ActionItemNodeView }
  | { kind: 'toggle'; id: string; status: 'open' | 'done' }
  | { kind: 'assign'; id: string; party: AssigneeParty; label: string | null }
  | { kind: 'edit'; id: string; body: string; dueLabel: string | null; dueAtValue: string | null }
  | { kind: 'remove'; id: string };

/** `YYYY-MM-DD` → "9 Jul 2026" (UTC) — the OPTIMISTIC due chip; server truth replaces it on refresh. */
function formatDueChip(dateValue: string): string {
  return new Date(`${dateValue}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** A native `<input type="date">` value → the full ISO datetime the Server Actions accept. */
function dueValueToIso(dateValue: string): string {
  return `${dateValue}T00:00:00.000Z`;
}

/** Optimistic overdue check: past a set due date while still open. Server value replaces it. */
function isOverdueForValue(dueAtValue: string | null, status: 'open' | 'done'): boolean {
  return (
    dueAtValue !== null &&
    status === 'open' &&
    new Date(dueValueToIso(dueAtValue)).getTime() < Date.now()
  );
}

/** Party → prospective label (`null` = unassigned). Flat branches (no nested ternary). */
function labelForParty(
  party: AssigneeParty,
  clientCompanyName: string,
  expertPartyShort: string
): string | null {
  if (party === 'client') return clientCompanyName;
  if (party === 'expert') return expertPartyShort;
  return null;
}

/**
 * The interactive action-items surface on the delivery workspace (BAL-391 / ADR-1043).
 * Models on `ExpertMilestoneRail`: `useOptimistic` + `useTransition`, Sonner toast +
 * `router.refresh()` on BOTH outcomes, shadcn primitives, dark-mode tokens. Receives ONLY
 * the serialisable `ActionItemsPanelView` (never `@balo/db`) so the client-bundle posture
 * holds. Affordances (add / toggle done / assign to a side / edit body + due / remove)
 * render only when `canWrite` (a live, active engagement); otherwise the list renders
 * read-only. All four states: loading (pending disables controls), empty (an invitation
 * when writable — nothing when a read-only list is empty), error (toast the returned copy
 * verbatim), success (toast own copy + refresh). Assignee is named by PARTY; due dates are
 * stated as helpful facts, never as a countdown.
 */
export function ActionItemsPanel({
  view,
}: Readonly<ActionItemsPanelProps>): React.JSX.Element | null {
  const { engagementId, canWrite, clientCompanyName, expertPartyShort } = view;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editTarget, setEditTarget] = useState<ActionItemNodeView | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ActionItemNodeView | null>(null);
  const [addBody, setAddBody] = useState('');
  const [addDue, setAddDue] = useState('');

  const reducer = useCallback(
    (list: ActionItemNodeView[], action: PanelAction): ActionItemNodeView[] => {
      if (action.kind === 'add') {
        return [...list, action.node];
      }
      if (action.kind === 'remove') {
        return list.filter((item) => item.id !== action.id);
      }
      return list.map((item) => {
        if (item.id !== action.id) return item;
        if (action.kind === 'toggle') {
          return {
            ...item,
            status: action.status,
            isOverdue: isOverdueForValue(item.dueAtValue, action.status),
          };
        }
        if (action.kind === 'assign') {
          return { ...item, assigneeParty: action.party, assigneeLabel: action.label };
        }
        // edit
        return {
          ...item,
          body: action.body,
          dueLabel: action.dueLabel,
          dueAtValue: action.dueAtValue,
          isOverdue: isOverdueForValue(action.dueAtValue, item.status),
        };
      });
    },
    []
  );

  const [optimistic, applyOptimistic] = useOptimistic(view.items, reducer);

  const settle = useCallback(
    (res: ActionItemActionResult, okMsg: string): void => {
      if (res.success) toast.success(okMsg);
      else toast.error(res.error);
      // Reconcile on BOTH outcomes — the RSC payload snaps the list back to server truth.
      router.refresh();
    },
    [router]
  );

  const runAdd = useCallback((): void => {
    const body = addBody.trim();
    if (body === '') return;
    const dueAtValue = addDue === '' ? null : addDue;
    const node: ActionItemNodeView = {
      id: crypto.randomUUID(),
      body,
      status: 'open',
      assigneeParty: null,
      assigneeLabel: null,
      dueLabel: dueAtValue === null ? null : formatDueChip(dueAtValue),
      dueAtValue,
      isOverdue: isOverdueForValue(dueAtValue, 'open'),
    };
    startTransition(async () => {
      applyOptimistic({ kind: 'add', node });
      setAddBody('');
      setAddDue('');
      settle(
        await createActionItemAction({
          engagementId,
          body,
          dueAt: dueAtValue === null ? undefined : dueValueToIso(dueAtValue),
        }),
        'Action item added'
      );
    });
  }, [addBody, addDue, applyOptimistic, engagementId, settle]);

  const runToggle = useCallback(
    (node: ActionItemNodeView): void => {
      const status = node.status === 'open' ? 'done' : 'open';
      startTransition(async () => {
        applyOptimistic({ kind: 'toggle', id: node.id, status });
        settle(
          await setActionItemStatusAction({ engagementId, actionItemId: node.id, status }),
          status === 'done' ? 'Marked done' : 'Reopened'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const runAssign = useCallback(
    (node: ActionItemNodeView, party: AssigneeParty): void => {
      const label = labelForParty(party, clientCompanyName, expertPartyShort);
      startTransition(async () => {
        applyOptimistic({ kind: 'assign', id: node.id, party, label });
        settle(
          await assignActionItemAction({
            engagementId,
            actionItemId: node.id,
            assigneeParty: party,
          }),
          party === null ? 'Unassigned' : 'Assigned'
        );
      });
    },
    [applyOptimistic, clientCompanyName, engagementId, expertPartyShort, settle]
  );

  const runEdit = useCallback(
    (node: ActionItemNodeView, body: string, dueAtValue: string | null): void => {
      startTransition(async () => {
        applyOptimistic({
          kind: 'edit',
          id: node.id,
          body,
          dueLabel: dueAtValue === null ? null : formatDueChip(dueAtValue),
          dueAtValue,
        });
        setEditTarget(null);
        settle(
          await updateActionItemAction({
            engagementId,
            actionItemId: node.id,
            body,
            dueAt: dueAtValue === null ? null : dueValueToIso(dueAtValue),
          }),
          'Action item updated'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const runRemove = useCallback(
    (node: ActionItemNodeView): void => {
      startTransition(async () => {
        applyOptimistic({ kind: 'remove', id: node.id });
        setRemoveTarget(null);
        settle(
          await removeActionItemAction({ engagementId, actionItemId: node.id }),
          'Action item removed'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const handleEditConfirm = useCallback(
    (body: string, dueAtValue: string | null): void => {
      if (editTarget !== null) runEdit(editTarget, body, dueAtValue);
    },
    [editTarget, runEdit]
  );
  const closeEdit = useCallback((): void => setEditTarget(null), []);
  const handleRemoveConfirm = useCallback((): void => {
    if (removeTarget !== null) runRemove(removeTarget);
  }, [removeTarget, runRemove]);
  const closeRemove = useCallback((): void => setRemoveTarget(null), []);
  const handleAddKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runAdd();
      }
    },
    [runAdd]
  );

  // A read-only, item-less panel is purely retrospective — nothing to act on → render
  // nothing (the workspace also guards this; belt-and-braces).
  if (!canWrite && optimistic.length === 0) {
    return null;
  }

  const assigneeOptions: {
    value: 'unassigned' | 'client' | 'expert';
    party: AssigneeParty;
    label: string;
  }[] = [
    { value: 'unassigned', party: null, label: 'Unassigned' },
    { value: 'client', party: 'client', label: clientCompanyName },
    { value: 'expert', party: 'expert', label: expertPartyShort },
  ];

  return (
    <>
      <Card className="border-border bg-card p-6">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
          <ListChecks className="size-3.5" aria-hidden />
          Action items
        </div>

        {optimistic.length === 0 ? (
          <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
            Add the first action item so both sides stay aligned on what happens next.
          </p>
        ) : (
          <ul className="divide-border mt-4 divide-y">
            {optimistic.map((node) => (
              <li key={node.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                {canWrite ? (
                  <Checkbox
                    className="mt-0.5"
                    checked={node.status === 'done'}
                    disabled={isPending}
                    onCheckedChange={() => runToggle(node)}
                    aria-label={
                      node.status === 'done'
                        ? `Reopen action item: ${node.body}`
                        : `Mark done: ${node.body}`
                    }
                  />
                ) : (
                  <>
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                        node.status === 'done'
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input'
                      )}
                      aria-hidden
                    >
                      {node.status === 'done' ? <Check className="size-3" /> : null}
                    </span>
                    <span className="sr-only">{node.status === 'done' ? 'Done' : 'Open'}</span>
                  </>
                )}

                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'text-sm leading-relaxed',
                      node.status === 'done'
                        ? 'text-muted-foreground line-through'
                        : 'text-foreground'
                    )}
                  >
                    {node.body}
                  </p>
                  <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="size-3" aria-hidden />
                      {node.assigneeLabel ?? 'Unassigned'}
                    </span>
                    {node.dueLabel !== null && (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1',
                          node.isOverdue ? 'text-destructive' : 'text-muted-foreground'
                        )}
                      >
                        <CalendarDays className="size-3" aria-hidden />
                        {node.isOverdue ? `Past due · ${node.dueLabel}` : `Due ${node.dueLabel}`}
                      </span>
                    )}
                  </div>
                </div>

                {canWrite && (
                  <div className="flex shrink-0 items-center gap-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground h-7 gap-1 px-2"
                          disabled={isPending}
                        >
                          <UserRound className="size-3.5" aria-hidden />
                          <span className="sr-only">Assign action item</span>
                          <ChevronDown className="size-3" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuRadioGroup value={node.assigneeParty ?? 'unassigned'}>
                          {assigneeOptions.map((option) => (
                            <DropdownMenuRadioItem
                              key={option.value}
                              value={option.value}
                              onSelect={() => runAssign(node, option.party)}
                            >
                              {option.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground size-7"
                      disabled={isPending}
                      onClick={() => setEditTarget(node)}
                      aria-label={`Edit action item: ${node.body}`}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive size-7"
                      disabled={isPending}
                      onClick={() => setRemoveTarget(node)}
                      aria-label={`Remove action item: ${node.body}`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canWrite && (
          <div className="border-border mt-4 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center">
            <Input
              value={addBody}
              maxLength={2000}
              disabled={isPending}
              onChange={(event) => setAddBody(event.target.value)}
              onKeyDown={handleAddKeyDown}
              placeholder="Add an action item…"
              aria-label="New action item"
              className="flex-1"
            />
            <Input
              type="date"
              value={addDue}
              disabled={isPending}
              onChange={(event) => setAddDue(event.target.value)}
              aria-label="Due date (optional)"
              className="sm:w-[160px]"
            />
            <Button
              type="button"
              variant="default"
              disabled={isPending || addBody.trim() === ''}
              onClick={runAdd}
            >
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
        )}
      </Card>

      <EditActionItemDialog
        target={editTarget}
        pending={isPending}
        onConfirm={handleEditConfirm}
        onCancel={closeEdit}
      />

      <RemoveActionItemDialog
        target={removeTarget}
        pending={isPending}
        onConfirm={handleRemoveConfirm}
        onCancel={closeRemove}
      />
    </>
  );
}

const EDIT_BODY_ID = 'action-item-edit-body';
const EDIT_DUE_ID = 'action-item-edit-due';

interface EditActionItemDialogProps {
  /** The item under edit; `null` closes the dialog. */
  target: ActionItemNodeView | null;
  pending: boolean;
  onConfirm: (body: string, dueAtValue: string | null) => void;
  onCancel: () => void;
}

/**
 * The edit dialog for one action item — body (required) + optional due date. Seeds from
 * the target each open (like `MilestoneFormModal`). Blocks close while `pending`; the save
 * CTA stays disabled until the body is non-empty. An empty due input CLEARS the due date.
 */
function EditActionItemDialog({
  target,
  pending,
  onConfirm,
  onCancel,
}: Readonly<EditActionItemDialogProps>): React.JSX.Element {
  const [body, setBody] = useState('');
  const [due, setDue] = useState('');
  const open = target !== null;

  useEffect(() => {
    if (target === null) return;
    setBody(target.body);
    setDue(target.dueAtValue ?? '');
  }, [target]);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending) return; // no close mid-flight
      if (!next) onCancel();
    },
    [pending, onCancel]
  );

  const handleConfirm = useCallback((): void => {
    onConfirm(body.trim(), due === '' ? null : due);
  }, [onConfirm, body, due]);

  const canSubmit = body.trim() !== '' && !pending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Edit action item</DialogTitle>
          <DialogDescription>
            Update the wording or set a due date. Assign it to a side from the item&rsquo;s menu.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={EDIT_BODY_ID}>Action item</Label>
            <Textarea
              id={EDIT_BODY_ID}
              rows={2}
              maxLength={2000}
              value={body}
              disabled={pending}
              onChange={(event) => setBody(event.target.value)}
              placeholder="What needs to happen"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={EDIT_DUE_ID}>Due date (optional)</Label>
            <Input
              id={EDIT_DUE_ID}
              type="date"
              value={due}
              disabled={pending}
              onChange={(event) => setDue(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="default" type="button" onClick={handleConfirm} disabled={!canSubmit}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Check className="size-4" aria-hidden />
            )}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RemoveActionItemDialogProps {
  /** The item pending removal; `null` closes the dialog. */
  target: ActionItemNodeView | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The remove-action-item confirm dialog — the required confirmation step before a
 * destructive remove (mirrors `RemoveMilestoneModal`, same shadcn `Dialog` primitive and
 * copy-tone). Non-blocking, focus-trapped, Esc cancels; blocks close while `pending`, and
 * the destructive CTA shows a spinner in flight. Only the confirm calls the remove action.
 * Gender-neutral copy stated as a helpful fact, never adversarial.
 */
function RemoveActionItemDialog({
  target,
  pending,
  onConfirm,
  onCancel,
}: Readonly<RemoveActionItemDialogProps>): React.JSX.Element {
  const open = target !== null;

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
          <DialogTitle>Remove this action item?</DialogTitle>
          <DialogDescription>
            <strong className="text-foreground font-semibold">{target?.body}</strong> comes off the
            shared list both sides can see. You can add it again anytime.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" type="button" onClick={onConfirm} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-4" aria-hidden />
            )}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
