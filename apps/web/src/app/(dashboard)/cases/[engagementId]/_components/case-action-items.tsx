'use client';

import { useCallback, useOptimistic, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CircleCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { SectionHead } from '@/components/balo/section/section-states';
import { cn } from '@/lib/utils';
import type { ActionItemNodeView } from '@/lib/engagement/action-items-view';
import type { CaseActionItemsView } from '@/lib/cases/case-view-types';
import { setCaseActionItemStatusAction } from '../_actions/set-case-action-item-status';

type ToggleItem = (item: ActionItemNodeView) => void;

/**
 * BAL-421 — action items, grouped Yours / Theirs / Unassigned, lens-relative.
 *
 * Marking an item done (or reopening it) is the ONE write offered here, through
 * `setCaseActionItemStatusAction`; the checkbox is live only when `canToggle` (case open AND the
 * viewer holds `mayToggleCaseActionItems`), otherwise it renders as a static status mark. Add /
 * assign / edit / remove stay project-only — their actions gate through the project loader.
 *
 * ⚠⚠ THE UNASSIGNED GROUP RENDERS EVEN WHEN THE OTHER TWO ARE EMPTY, AND IT IS NOT AN
 * AFTERTHOUGHT — it is where `ai_extracted` items land, i.e. a TRIAGE QUEUE. Hiding it would
 * hide the only place the transcript pipeline's output becomes visible.
 *
 * ⚠ THE EMPTY STATE IS AN INVITATION, NOT AN ABSENCE. The balo-ui rule: never define a section
 * by what it lacks ("No action items yet"). The card states what action items ARE and where
 * they come from, so the section reads as ready rather than broken.
 */
export function CaseActionItems({
  engagementId,
  actionItems,
}: Readonly<{ engagementId: string; actionItems: CaseActionItemsView }>): React.JSX.Element {
  const { yours, theirs, unassigned, counterpartyLabel, totalCount, canToggle } = actionItems;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [optimisticStatus, applyOptimisticStatus] = useOptimistic(
    new Map<string, 'open' | 'done'>(),
    (current, patch: { id: string; status: 'open' | 'done' }) =>
      new Map(current).set(patch.id, patch.status)
  );

  const withStatus = (items: readonly ActionItemNodeView[]): ActionItemNodeView[] =>
    items.map((item) => {
      const status = optimisticStatus.get(item.id);
      return status === undefined ? item : { ...item, status };
    });
  const yoursItems = withStatus(yours);
  const theirsItems = withStatus(theirs);
  const unassignedItems = withStatus(unassigned);
  const doneCount = [...yoursItems, ...theirsItems, ...unassignedItems].filter(
    (item) => item.status === 'done'
  ).length;

  const toggle = useCallback<ToggleItem>(
    (item) => {
      const status = item.status === 'open' ? 'done' : 'open';
      startTransition(async () => {
        applyOptimisticStatus({ id: item.id, status });
        const result = await setCaseActionItemStatusAction({
          engagementId,
          actionItemId: item.id,
          status,
        });
        if (result.success) {
          toast.success(status === 'done' ? 'Marked done' : 'Reopened');
        } else {
          toast.error(result.error);
        }
        // Reconcile on BOTH outcomes — the RSC payload snaps the list back to server truth.
        router.refresh();
      });
    },
    [applyOptimisticStatus, engagementId, router]
  );

  const onToggle = canToggle ? toggle : undefined;

  return (
    <section className="bg-card border-border rounded-xl border px-5 py-4">
      <SectionHead
        icon={CircleCheck}
        title="Action items"
        meta={totalCount > 0 ? `${doneCount}/${totalCount}` : undefined}
      />
      {totalCount === 0 ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Anything you agree to do on a call lands here, so nothing gets lost between consultations.
        </p>
      ) : (
        <>
          <ItemGroup label="Yours" items={yoursItems} onToggle={onToggle} pending={isPending} />
          <ItemGroup
            label={`${counterpartyLabel}'s`}
            items={theirsItems}
            onToggle={onToggle}
            pending={isPending}
          />
          <ItemGroup
            label="Unassigned"
            items={unassignedItems}
            onToggle={onToggle}
            pending={isPending}
            muted
          />
        </>
      )}
    </section>
  );
}

function ItemGroup({
  label,
  items,
  onToggle,
  pending,
  muted = false,
}: Readonly<{
  label: string;
  items: readonly ActionItemNodeView[];
  /** Present iff the viewer may toggle — absent renders the static status mark. */
  onToggle: ToggleItem | undefined;
  pending: boolean;
  muted?: boolean;
}>) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 last:mb-0">
      <p
        className={cn(
          'mb-1.5 text-xs font-medium',
          muted ? 'text-muted-foreground/70' : 'text-muted-foreground'
        )}
      >
        {label}
      </p>
      <ul className="flex list-none flex-col gap-1.5">
        {/* ⚠ KEYED ON THE ITEM ID, NEVER ON AN ARRAY INDEX (SonarCloud S6479). */}
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2">
            {onToggle === undefined ? (
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded',
                  item.status === 'done' ? 'bg-success' : 'border-border border-[1.5px]'
                )}
              >
                {item.status === 'done' && (
                  <Check size={9} strokeWidth={3.5} className="text-background" />
                )}
              </span>
            ) : (
              <Checkbox
                className="mt-0.5"
                checked={item.status === 'done'}
                disabled={pending}
                onCheckedChange={() => onToggle(item)}
                aria-label={
                  item.status === 'done'
                    ? `Reopen action item: ${item.body}`
                    : `Mark done: ${item.body}`
                }
              />
            )}
            <span
              className={cn(
                'text-xs leading-snug',
                item.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'
              )}
            >
              {item.body}
              {onToggle === undefined && (
                <span className="sr-only">{item.status === 'done' ? ' (done)' : ' (open)'}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
