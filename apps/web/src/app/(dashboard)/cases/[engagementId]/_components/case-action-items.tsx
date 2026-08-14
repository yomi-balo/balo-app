'use client';

import { Check, CircleCheck } from 'lucide-react';
import { SectionHead } from '@/components/balo/section/section-states';
import { cn } from '@/lib/utils';
import type { ActionItemNodeView } from '@/lib/engagement/action-items-view';
import type { CaseActionItemsView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — action items, grouped Yours / Theirs / Unassigned, lens-relative.
 *
 * ⚠⚠ READ-ONLY ON THIS SURFACE, AND THAT IS HONESTY RATHER THAN CAUTION. All five mutating
 * action-item Server Actions live under `engagements/[id]/_actions/` and gate through
 * `projectEngagementsRepository.findWithMilestones`, whose query filters
 * `engagement_type = 'project'` — so a CASE id can never resolve and every toggle / assign /
 * edit would toast "This engagement could not be found" on EVERY click. A panel whose controls
 * always error is worse than a panel that does not offer them. Case-grain equivalents are a
 * second ticket's worth of authorization surface.
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
  actionItems,
}: Readonly<{ actionItems: CaseActionItemsView }>): React.JSX.Element {
  const { yours, theirs, unassigned, counterpartyLabel, doneCount, totalCount } = actionItems;

  return (
    <section className="bg-card border-border rounded-3xl border px-5 py-4">
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
          <ItemGroup label="Yours" items={yours} />
          <ItemGroup label={`${counterpartyLabel}'s`} items={theirs} />
          <ItemGroup label="Unassigned" items={unassigned} muted />
        </>
      )}
    </section>
  );
}

function ItemGroup({
  label,
  items,
  muted = false,
}: Readonly<{ label: string; items: readonly ActionItemNodeView[]; muted?: boolean }>) {
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
            <span
              className={cn(
                'text-xs leading-snug',
                item.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'
              )}
            >
              {item.body}
              <span className="sr-only">{item.status === 'done' ? ' (done)' : ' (open)'}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
