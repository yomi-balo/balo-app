'use client';

import { useCallback, useOptimistic, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Flag, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import type { MilestoneNodeView } from '@/lib/engagement/engagement-view';
import { MilestoneRow } from './milestone-row';
import { CompleteMilestoneModal } from './complete-milestone-modal';
import { RevertMilestoneModal } from './revert-milestone-modal';
import { startMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/start-milestone';
import { completeMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/complete-milestone';
import { revertMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/revert-milestone';
import type { MilestoneActionResult } from '@/app/(dashboard)/engagements/[id]/_actions/milestone-action-shared';

interface ExpertMilestoneRailProps {
  engagementId: string;
  /** Descriptions are ALREADY server-sanitised by the view-mapper. */
  milestones: MilestoneNodeView[];
  /** Optimistic "Completed today by {name}" attribution. */
  expertPersonShort: string;
  /** Modal copy + the notify footnote. */
  clientCompanyName: string;
}

/** Optimistic patch instructions applied by {@link makeMilestoneReducer}. */
type MilestoneAction =
  | { kind: 'start'; id: string }
  | { kind: 'complete'; id: string; note: string }
  | { kind: 'revert'; id: string };

/**
 * The interactive delivery rail for the delivering expert while the engagement is
 * `active` (BAL-332 / D2). Owns `useOptimistic` + `useTransition`, derives the
 * one-emphasized-action `nextId`, renders per-status actions in the shared row's
 * `actions` slot, hosts the complete-note + revert-confirm modals, fires Sonner
 * toasts, calls the three Server Actions, and `router.refresh()`es to reconcile the
 * optimistic patch against server truth on BOTH outcomes.
 *
 * D3 (add / edit / remove milestone) and D4 (mark project complete) affordances are
 * deliberately OUT OF SCOPE — not rendered here.
 */
export function ExpertMilestoneRail({
  engagementId,
  milestones,
  expertPersonShort,
  clientCompanyName,
}: Readonly<ExpertMilestoneRailProps>): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [completeTarget, setCompleteTarget] = useState<MilestoneNodeView | null>(null);
  const [revertTarget, setRevertTarget] = useState<MilestoneNodeView | null>(null);

  const reducer = useCallback(
    (list: MilestoneNodeView[], action: MilestoneAction): MilestoneNodeView[] =>
      list.map((m) => {
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
      }),
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

  const handleCompleteConfirm = useCallback(
    (note: string): void => {
      if (completeTarget !== null) runComplete(completeTarget, note);
    },
    [completeTarget, runComplete]
  );
  const handleRevertConfirm = useCallback((): void => {
    if (revertTarget !== null) runRevert(revertTarget);
  }, [revertTarget, runRevert]);
  const closeComplete = useCallback((): void => setCompleteTarget(null), []);
  const closeRevert = useCallback((): void => setRevertTarget(null), []);

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

  return (
    <>
      <Card className="border-border bg-card p-6">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
          <Flag className="size-3.5" aria-hidden />
          Delivery plan
        </div>
        <div className="mt-4">
          {optimistic.map((node, index) => (
            <MilestoneRow
              key={node.id}
              node={node}
              isLast={index === optimistic.length - 1}
              actions={actionsFor(node)}
            />
          ))}
        </div>
        <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
          {clientCompanyName} and Balo are notified when you complete or reopen a milestone.
        </p>
      </Card>

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
}
