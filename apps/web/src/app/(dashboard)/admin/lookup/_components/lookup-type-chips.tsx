'use client';

import { LOOKUP_TYPE_FILTERS, type LookupTypeFilter } from '@balo/shared/lookup';
import { cn } from '@/lib/utils';
import { LOOKUP_FILTER_LABEL } from '../_lib/lookup-view';

/**
 * BAL-551 — the five type chips. Live counts over the CURRENT query's result set. A chip with
 * zero results is dimmed and `disabled`, never hidden — except the active one, which stays
 * clickable-looking even at zero (it is already selected).
 *
 * ⚠ THESE ARE FILTER BUTTONS, NOT TABS — `role="group"` + `aria-pressed`, never
 * `role="tablist"`/`"tab"`, and no `motion/react` import. That keeps this structurally outside
 * `tabs-are-static.test.ts`'s subject matter (BAL-551 scope ruling, cut 7 — the chip sub-nav
 * `CONTROLS` entry is BAL-548's, not this ticket's).
 */

interface LookupTypeChipsProps {
  readonly filter: LookupTypeFilter;
  readonly counts: Record<LookupTypeFilter, number>;
  readonly onSelect: (filter: LookupTypeFilter) => void;
}

export function LookupTypeChips({
  filter,
  counts,
  onSelect,
}: Readonly<LookupTypeChipsProps>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Filter results by type"
      className="flex gap-1.5 overflow-x-auto pb-1"
    >
      {LOOKUP_TYPE_FILTERS.map((key) => {
        const active = filter === key;
        const count = counts[key];
        const dead = count === 0 && !active;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            disabled={dead}
            onClick={() => onSelect(key)}
            className={cn(
              'focus-visible:ring-ring inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none',
              active
                ? 'border-primary/40 bg-primary/10 text-primary font-semibold'
                : dead
                  ? 'border-border text-muted-foreground cursor-default opacity-55'
                  : 'border-border text-muted-foreground hover:text-foreground bg-card'
            )}
          >
            {LOOKUP_FILTER_LABEL[key]}
            <span
              className={cn(
                'text-[11px] font-bold tabular-nums',
                active ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
