'use client';

import { useRouter } from 'next/navigation';
import type { ApplicationReviewFilter } from '@balo/db';
import { cn } from '@/lib/utils';
import { APPLICATION_LIST_FILTERS, APPLICATION_FILTER_LABEL } from '../_lib/application-list-view';

/**
 * BAL-549 — the three application chips, cloned from `admin/lookup/_components/
 * lookup-type-chips.tsx`'s markup and a11y exactly: `role="group"`, `aria-pressed`, `disabled`
 * on a dead chip, `min-h-[44px]`, the active/dead/idle triad.
 *
 * ⚠ FILTER BUTTONS, NOT TABS — never `role="tablist"`/`"tab"`, which keeps this outside
 * `tabs-are-static.test.ts`'s subject matter.
 *
 * ⚠ THE FILTER LIVES IN THE URL (`?filter=`), unlike Lookup's chips (client-only state) — the
 * server list read is keyed on it, so a chip click is a `router.replace`, not `setState`.
 *
 * `ApplicationReviewFilter` is a TYPE-ONLY import from `@balo/db` — erased at compile time, so
 * this `'use client'` leaf never drags the postgres driver into the browser bundle (memory
 * `reference_balo_db_client_bundle_footgun`).
 */

interface ApplicationFilterChipsProps {
  readonly filter: ApplicationReviewFilter;
  readonly counts: Record<ApplicationReviewFilter, number>;
}

/** Extracted so the state choice reads as early returns, not a nested ternary. */
function chipStateClassName(active: boolean, dead: boolean): string {
  if (active) return 'border-primary/40 bg-primary/10 text-primary font-semibold';
  if (dead) return 'border-border text-muted-foreground cursor-default opacity-55';
  return 'border-border text-muted-foreground hover:text-foreground bg-card';
}

export function ApplicationFilterChips({
  filter,
  counts,
}: Readonly<ApplicationFilterChipsProps>): React.JSX.Element {
  const router = useRouter();

  return (
    <div
      role="group"
      aria-label="Filter applications"
      className="flex gap-1.5 overflow-x-auto pb-1"
    >
      {APPLICATION_LIST_FILTERS.map((key) => {
        const active = filter === key;
        const count = counts[key];
        const dead = count === 0 && !active;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            disabled={dead}
            onClick={() => router.replace(`/admin/applications?filter=${key}`, { scroll: false })}
            className={cn(
              'focus-visible:ring-ring inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none',
              chipStateClassName(active, dead)
            )}
          >
            {APPLICATION_FILTER_LABEL[key]}
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
