'use client';

import { Check } from 'lucide-react';
import type { EnabledNavEntry, NavBadgeSource } from './nav-registry';

export interface NavBadgeCounts {
  readonly checklistCompletedCount: number;
  readonly checklistAllComplete: boolean;
}

/**
 * ⚠ A `Record` OVER THE UNION, ON PURPOSE. Adding a member to `NavBadgeSource` without adding a
 * renderer here is a COMPILE ERROR — a `switch` or a ternary would silently render nothing.
 * (`noUncheckedIndexedAccess` does not widen a finite-literal-keyed Record, so the lookup below
 * is non-optional.)
 *
 * BAL-501 (D7) — moved verbatim from `sidebar.tsx` so the More sheet can render the same badges.
 * The rendered classes must not change: `sidebar.test.tsx` pins `.bg-success\/10` on the
 * all-complete branch.
 */
export const NAV_BADGE_RENDERERS: Record<
  NavBadgeSource,
  (counts: NavBadgeCounts) => React.JSX.Element
> = {
  expertChecklist: ({ checklistCompletedCount, checklistAllComplete }) => (
    <ChecklistBadge completedCount={checklistCompletedCount} allComplete={checklistAllComplete} />
  ),
};

function ChecklistBadge({
  completedCount,
  allComplete,
}: {
  completedCount: number;
  allComplete: boolean;
}): React.JSX.Element {
  if (allComplete) {
    return (
      <span
        className="bg-success/10 text-success flex h-5 w-5 items-center justify-center rounded-full"
        style={{ animation: 'checkPop 0.3s ease-out' }}
      >
        <Check className="h-3 w-3" />
      </span>
    );
  }

  return (
    <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10px] font-semibold">
      {completedCount}/5
    </span>
  );
}

/**
 * ⚠ A SECOND `Record` OVER THE SAME UNION, ON PURPOSE. Adding a member to `NavBadgeSource`
 * without a predicate here is a COMPILE ERROR — which is the only thing that stops a future
 * badge source from being invisible behind a closed More sheet.
 */
export const NAV_BADGE_NEEDS_ATTENTION: Record<
  NavBadgeSource,
  (counts: NavBadgeCounts) => boolean
> = {
  // All-complete renders a green check, which reads as RESOLVED, not pending — so it must
  // NOT keep the rollup dot lit (design-spec.md:200-204).
  expertChecklist: ({ checklistAllComplete }) => !checklistAllComplete,
};

/** BAL-501 — does ANY of `items` have a badge that currently needs attention? Drives the More
 *  tab's rollup dot: the one real badge gap this redesign must not regress. */
export function hasMoreAttention(
  items: readonly EnabledNavEntry[],
  counts: NavBadgeCounts
): boolean {
  return items.some(
    (entry) =>
      entry.badgeSource !== undefined && NAV_BADGE_NEEDS_ATTENTION[entry.badgeSource](counts)
  );
}

/** Dynamic accessible name for the More button. Pure, so the grammar is unit-testable. */
export function moreButtonLabel(attentionCount: number): string {
  if (attentionCount <= 0) return 'More';
  if (attentionCount === 1) return 'More, 1 item needs attention';
  return `More, ${attentionCount} items need attention`;
}
