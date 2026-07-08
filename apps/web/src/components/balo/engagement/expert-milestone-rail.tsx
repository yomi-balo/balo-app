'use client';

import { useCallback, useMemo, useOptimistic, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Flag,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import type { EmptyStateView, MilestoneNodeView } from '@/lib/engagement/engagement-view';
import { MilestoneRow } from './milestone-row';
import { MilestoneEmptyState } from './milestone-empty-state';
import { CompleteMilestoneModal } from './complete-milestone-modal';
import { RevertMilestoneModal } from './revert-milestone-modal';
import {
  MilestoneFormModal,
  type MilestoneFormInitial,
  type MilestoneFormValues,
} from './milestone-form-modal';
import { RemoveMilestoneModal } from './remove-milestone-modal';
import { startMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/start-milestone';
import { completeMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/complete-milestone';
import { revertMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/revert-milestone';
import { addMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/add-milestone';
import { updateMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/update-milestone';
import { removeMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/remove-milestone';
import { reorderMilestonesAction } from '@/app/(dashboard)/engagements/[id]/_actions/reorder-milestones';
import type { MilestoneActionResult } from '@/app/(dashboard)/engagements/[id]/_actions/milestone-action-shared';

interface ExpertMilestoneRailProps {
  engagementId: string;
  /** Descriptions are ALREADY server-sanitised by the view-mapper. */
  milestones: MilestoneNodeView[];
  /** The expert-lens invitation copy, shown when the plan is empty. Null suppresses it. */
  emptyState: EmptyStateView | null;
  /** Optimistic "Completed today by {name}" attribution. */
  expertPersonShort: string;
  /** Modal copy + the notify footnote. */
  clientCompanyName: string;
}

/** Optimistic patch instructions applied by the reducer. */
type MilestoneAction =
  | { kind: 'start'; id: string }
  | { kind: 'complete'; id: string; note: string }
  | { kind: 'revert'; id: string }
  | { kind: 'add'; node: MilestoneNodeView }
  | {
      kind: 'edit';
      id: string;
      title: string;
      descriptionText: string;
      acceptanceCriteria: string;
    }
  | { kind: 'remove'; id: string }
  | { kind: 'reorder'; orderedIds: string[] };

/** Which form-modal is open, and (for `edit`) against which node. */
interface FormModalState {
  mode: 'add' | 'edit';
  target: MilestoneNodeView | null;
}

/**
 * Escape a user's own plain text to safe inline HTML for the OPTIMISTIC node only —
 * the server-sanitised row replaces it on `router.refresh()`. Mirrors the plain-text →
 * `<p>` shape the server uses so the transient render matches. No injection surface:
 * the five HTML-significant characters are entity-escaped.
 */
function escapeToParagraphs(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const escaped = trimmed
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Blank plain text → null (so an empty optional field renders nothing). */
function textOrNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The interactive delivery rail for the delivering expert while the engagement is
 * `active` (BAL-332 / D2 + BAL-333 / D3). Owns `useOptimistic` + `useTransition`,
 * derives the one-emphasized-action `nextId`, renders per-status actions in the shared
 * row's `actions` slot, hosts the complete / revert / add-edit / remove modals, exposes
 * the D3 scope-edit affordances (add milestone, per-row edit / remove / reorder), fires
 * Sonner toasts, calls the Server Actions, and `router.refresh()`es to reconcile the
 * optimistic patch against server truth on BOTH outcomes.
 *
 * Also owns the EMPTY case: when there are no milestones it renders the expert
 * invitation with the "Add the first milestone" gradient CTA — so every D3 affordance
 * lives in this single client island.
 */
export function ExpertMilestoneRail({
  engagementId,
  milestones,
  emptyState,
  expertPersonShort,
  clientCompanyName,
}: Readonly<ExpertMilestoneRailProps>): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [completeTarget, setCompleteTarget] = useState<MilestoneNodeView | null>(null);
  const [revertTarget, setRevertTarget] = useState<MilestoneNodeView | null>(null);
  const [formModal, setFormModal] = useState<FormModalState | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MilestoneNodeView | null>(null);

  const reducer = useCallback(
    (list: MilestoneNodeView[], action: MilestoneAction): MilestoneNodeView[] => {
      if (action.kind === 'add') {
        return [...list, action.node];
      }
      if (action.kind === 'remove') {
        return list.filter((m) => m.id !== action.id);
      }
      if (action.kind === 'reorder') {
        const byId = new Map(list.map((m) => [m.id, m]));
        return action.orderedIds
          .map((id) => byId.get(id))
          .filter((m): m is MilestoneNodeView => m !== undefined);
      }
      return list.map((m) => {
        if (m.id !== action.id) return m;
        if (action.kind === 'start') {
          return {
            ...m,
            status: 'in_progress',
            nodeVariant: 'in_progress',
            statusLabel: 'In progress',
            startedLabel: 'Started today',
          };
        }
        if (action.kind === 'complete') {
          return {
            ...m,
            status: 'completed',
            nodeVariant: 'completed',
            statusLabel: 'Completed',
            connectorFilled: true,
            completedLabel: `Completed today by ${expertPersonShort}`,
            completionNote: action.note.trim() || null,
          };
        }
        if (action.kind === 'edit') {
          return {
            ...m,
            title: action.title,
            descriptionText: textOrNull(action.descriptionText),
            descriptionHtml: escapeToParagraphs(action.descriptionText),
            acceptanceCriteria: textOrNull(action.acceptanceCriteria),
          };
        }
        // revert
        return {
          ...m,
          status: 'in_progress',
          nodeVariant: 'in_progress',
          statusLabel: 'In progress',
          connectorFilled: false,
          completedLabel: null,
          completionNote: null,
        };
      });
    },
    [expertPersonShort]
  );

  const [optimistic, applyOptimistic] = useOptimistic(milestones, reducer);

  // One emphasized action at a time: the gradient "Mark complete" is the sole
  // prominent button whenever anything is in progress; otherwise the NEXT pending
  // milestone's Start gets primary weight (all other Starts render ghost).
  const hasInProgress = optimistic.some((m) => m.status === 'in_progress');
  const nextId = hasInProgress
    ? null
    : (optimistic.find((m) => m.status === 'pending')?.id ?? null);

  const settle = useCallback(
    (res: MilestoneActionResult, okMsg: string): void => {
      if (res.success) toast.success(okMsg);
      else toast.error(res.error);
      // Reconcile on BOTH outcomes — the RSC payload snaps the rail (and the D1
      // banners / progress bar above it) back to server truth.
      router.refresh();
    },
    [router]
  );

  const runStart = useCallback(
    (node: MilestoneNodeView): void => {
      startTransition(async () => {
        applyOptimistic({ kind: 'start', id: node.id });
        settle(
          await startMilestoneAction({ engagementId, milestoneId: node.id }),
          'Milestone started'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const runComplete = useCallback(
    (node: MilestoneNodeView, note: string): void => {
      startTransition(async () => {
        applyOptimistic({ kind: 'complete', id: node.id, note });
        setCompleteTarget(null);
        settle(
          await completeMilestoneAction({
            engagementId,
            milestoneId: node.id,
            completionNote: note.trim() || undefined,
          }),
          'Milestone marked complete'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const runRevert = useCallback(
    (node: MilestoneNodeView): void => {
      startTransition(async () => {
        applyOptimistic({ kind: 'revert', id: node.id });
        setRevertTarget(null);
        settle(
          await revertMilestoneAction({ engagementId, milestoneId: node.id }),
          'Milestone moved back to in progress'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const runAdd = useCallback(
    (values: MilestoneFormValues): void => {
      const optimisticNode: MilestoneNodeView = {
        id: crypto.randomUUID(),
        title: values.title.trim(),
        descriptionHtml: escapeToParagraphs(values.descriptionText),
        descriptionText: textOrNull(values.descriptionText),
        acceptanceCriteria: textOrNull(values.acceptanceCriteria),
        status: 'pending',
        nodeVariant: 'pending',
        statusLabel: 'Not started',
        connectorFilled: false,
        valueLabel: null,
        startedLabel: null,
        completedLabel: null,
        completionNote: null,
      };
      startTransition(async () => {
        applyOptimistic({ kind: 'add', node: optimisticNode });
        setFormModal(null);
        settle(
          await addMilestoneAction({
            engagementId,
            title: values.title.trim(),
            descriptionText: textOrNull(values.descriptionText) ?? undefined,
            acceptanceCriteria: textOrNull(values.acceptanceCriteria) ?? undefined,
          }),
          'Milestone added'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const runEdit = useCallback(
    (node: MilestoneNodeView, values: MilestoneFormValues): void => {
      startTransition(async () => {
        applyOptimistic({
          kind: 'edit',
          id: node.id,
          title: values.title.trim(),
          descriptionText: values.descriptionText,
          acceptanceCriteria: values.acceptanceCriteria,
        });
        setFormModal(null);
        settle(
          await updateMilestoneAction({
            engagementId,
            milestoneId: node.id,
            title: values.title.trim(),
            // Explicit null CLEARS the field server-side (blank text → cleared).
            descriptionText: textOrNull(values.descriptionText),
            acceptanceCriteria: textOrNull(values.acceptanceCriteria),
          }),
          'Milestone updated'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const runRemove = useCallback(
    (node: MilestoneNodeView): void => {
      startTransition(async () => {
        applyOptimistic({ kind: 'remove', id: node.id });
        setRemoveTarget(null);
        settle(
          await removeMilestoneAction({ engagementId, milestoneId: node.id }),
          'Milestone removed'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const runReorder = useCallback(
    (orderedIds: string[]): void => {
      startTransition(async () => {
        applyOptimistic({ kind: 'reorder', orderedIds });
        settle(
          await reorderMilestonesAction({ engagementId, orderedMilestoneIds: orderedIds }),
          'Order updated'
        );
      });
    },
    [applyOptimistic, engagementId, settle]
  );

  const moveMilestone = useCallback(
    (index: number, direction: -1 | 1): void => {
      const target = index + direction;
      if (target < 0 || target >= optimistic.length) return;
      const ordered = optimistic.map((m) => m.id);
      const moved = ordered[index];
      const swapped = ordered[target];
      if (moved === undefined || swapped === undefined) return;
      ordered[index] = swapped;
      ordered[target] = moved;
      runReorder(ordered);
    },
    [optimistic, runReorder]
  );

  // ── Modal open/confirm handlers ────────────────────────────────────────────
  const handleCompleteConfirm = useCallback(
    (note: string): void => {
      if (completeTarget !== null) runComplete(completeTarget, note);
    },
    [completeTarget, runComplete]
  );
  const handleRevertConfirm = useCallback((): void => {
    if (revertTarget !== null) runRevert(revertTarget);
  }, [revertTarget, runRevert]);
  const handleRemoveConfirm = useCallback((): void => {
    if (removeTarget !== null) runRemove(removeTarget);
  }, [removeTarget, runRemove]);
  const handleFormConfirm = useCallback(
    (values: MilestoneFormValues): void => {
      if (formModal === null) return;
      if (formModal.mode === 'edit' && formModal.target !== null) {
        runEdit(formModal.target, values);
      } else {
        runAdd(values);
      }
    },
    [formModal, runAdd, runEdit]
  );

  const openAdd = useCallback((): void => setFormModal({ mode: 'add', target: null }), []);
  const closeComplete = useCallback((): void => setCompleteTarget(null), []);
  const closeRevert = useCallback((): void => setRevertTarget(null), []);
  const closeForm = useCallback((): void => setFormModal(null), []);
  const closeRemove = useCallback((): void => setRemoveTarget(null), []);

  const formInitial = useMemo<MilestoneFormInitial | null>(() => {
    if (formModal?.mode !== 'edit' || formModal.target === null) return null;
    return {
      title: formModal.target.title,
      descriptionText: formModal.target.descriptionText,
      acceptanceCriteria: formModal.target.acceptanceCriteria,
    };
  }, [formModal]);

  function actionsFor(node: MilestoneNodeView): React.ReactNode {
    if (node.status === 'pending') {
      return (
        <Button
          size="sm"
          variant={node.id === nextId ? 'default' : 'ghost'}
          disabled={isPending}
          onClick={() => runStart(node)}
        >
          <Play className="size-3.5" aria-hidden />
          Start milestone
        </Button>
      );
    }
    if (node.status === 'in_progress') {
      return (
        <button
          type="button"
          disabled={isPending}
          onClick={() => setCompleteTarget(node)}
          className={cn(
            'focus-visible:ring-ring inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-semibold hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50',
            PROPOSAL_CTA_GRADIENT_CLASS
          )}
        >
          <Check className="size-3.5" aria-hidden />
          Mark complete
        </button>
      );
    }
    return (
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        disabled={isPending}
        onClick={() => setRevertTarget(node)}
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Move back to in progress
      </Button>
    );
  }

  function controlsFor(node: MilestoneNodeView, index: number): React.ReactNode {
    const isFirst = index === 0;
    const isLast = index === optimistic.length - 1;
    return (
      <>
        <Button
          size="icon"
          variant="ghost"
          className="text-muted-foreground size-7"
          disabled={isPending || isFirst}
          onClick={() => moveMilestone(index, -1)}
          aria-label={`Move ${node.title} up`}
        >
          <ChevronUp className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="text-muted-foreground size-7"
          disabled={isPending || isLast}
          onClick={() => moveMilestone(index, 1)}
          aria-label={`Move ${node.title} down`}
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="text-muted-foreground size-7"
          disabled={isPending}
          onClick={() => setFormModal({ mode: 'edit', target: node })}
          aria-label={`Edit ${node.title}`}
        >
          <Pencil className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive size-7"
          disabled={isPending}
          onClick={() => setRemoveTarget(node)}
          aria-label={`Remove ${node.title}`}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </>
    );
  }

  const modals = (
    <>
      <MilestoneFormModal
        open={formModal !== null}
        mode={formModal?.mode ?? 'add'}
        initial={formInitial}
        clientCompanyName={clientCompanyName}
        pending={isPending}
        onConfirm={handleFormConfirm}
        onCancel={closeForm}
      />
      <RemoveMilestoneModal
        open={removeTarget !== null}
        milestoneTitle={removeTarget?.title ?? ''}
        isCompleted={removeTarget?.status === 'completed'}
        clientCompanyName={clientCompanyName}
        pending={isPending}
        onConfirm={handleRemoveConfirm}
        onCancel={closeRemove}
      />
      <CompleteMilestoneModal
        open={completeTarget !== null}
        milestoneTitle={completeTarget?.title ?? ''}
        clientCompanyName={clientCompanyName}
        pending={isPending}
        onConfirm={handleCompleteConfirm}
        onCancel={closeComplete}
      />
      <RevertMilestoneModal
        open={revertTarget !== null}
        milestoneTitle={revertTarget?.title ?? ''}
        clientCompanyName={clientCompanyName}
        pending={isPending}
        onConfirm={handleRevertConfirm}
        onCancel={closeRevert}
      />
    </>
  );

  // ── Empty case: the invitation + "Add the first milestone" gradient CTA ──────
  if (optimistic.length === 0) {
    return (
      <>
        {emptyState !== null ? (
          <MilestoneEmptyState emptyState={emptyState} />
        ) : (
          <Card className="border-border bg-card px-8 py-12 text-center">
            <div className="bg-primary/10 text-primary mx-auto mb-4 flex size-[54px] items-center justify-center rounded-[15px]">
              <Flag className="size-6" aria-hidden />
            </div>
            <h2 className="text-foreground text-lg font-semibold">Shape the delivery plan</h2>
            <p className="text-muted-foreground mx-auto mt-2 max-w-[420px] text-sm leading-relaxed">
              Add your first milestone so {clientCompanyName} can follow progress.
            </p>
          </Card>
        )}
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={isPending}
            onClick={openAdd}
            className={cn(
              'focus-visible:ring-ring inline-flex h-10 items-center justify-center gap-2 rounded-md px-5 text-sm font-semibold hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50',
              PROPOSAL_CTA_GRADIENT_CLASS
            )}
          >
            <Plus className="size-4" aria-hidden />
            Add the first milestone
          </button>
        </div>
        {modals}
      </>
    );
  }

  return (
    <>
      <Card className="border-border bg-card p-6">
        <div className="flex items-center justify-between gap-2">
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
            <Flag className="size-3.5" aria-hidden />
            Delivery plan
          </div>
          <Button size="sm" variant="ghost" disabled={isPending} onClick={openAdd}>
            <Plus className="size-3.5" aria-hidden />
            Add milestone
          </Button>
        </div>
        <div className="mt-4">
          {optimistic.map((node, index) => (
            <MilestoneRow
              key={node.id}
              node={node}
              isLast={index === optimistic.length - 1}
              actions={actionsFor(node)}
              controls={controlsFor(node, index)}
            />
          ))}
        </div>
        <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
          {clientCompanyName} and Balo are notified when you complete a milestone or change the
          plan. The project goes to {clientCompanyName} for review as a whole when you mark it
          complete. Pricing is fixed from the accepted proposal — changes to price go through a new
          proposal.
        </p>
      </Card>

      {modals}
    </>
  );
}
