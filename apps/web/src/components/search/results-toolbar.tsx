'use client';

import { useCallback } from 'react';
import { Grid3x3, List, Shield, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, SEARCH_EVENTS } from '@/lib/analytics';
import type { SortValue } from '@/lib/search/filters';
import { useUpdateSearchParams } from './use-update-search-params';
import { SortDropdown } from './sort-dropdown';

type Layout = 'grid' | 'list';

interface ResultsToolbarProps {
  /** Count rendered on this page. */
  shown: number;
  /** Total matching experts. */
  total: number;
  layout: Layout;
  sort: SortValue;
  activeCount: number;
  onOpenFilters: () => void;
}

const LAYOUT_OPTIONS: ReadonlyArray<{ value: Layout; Icon: typeof Grid3x3; label: string }> = [
  { value: 'grid', Icon: Grid3x3, label: 'Grid view' },
  { value: 'list', Icon: List, label: 'List view' },
];

export function ResultsToolbar({
  shown,
  total,
  layout,
  sort,
  activeCount,
  onOpenFilters,
}: Readonly<ResultsToolbarProps>): React.JSX.Element {
  const { setChromeParam } = useUpdateSearchParams();

  const handleLayout = useCallback(
    (next: Layout) => {
      if (next === layout) return;
      track(SEARCH_EVENTS.LAYOUT_TOGGLED, { to: next });
      // `layout` is page chrome, not a filter — preserve the current page.
      setChromeParam('layout', next === 'grid' ? null : next);
    },
    [layout, setChromeParam]
  );

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-foreground text-xl font-semibold md:text-[22px]">
            {shown} <span className="text-muted-foreground font-medium">of {total} experts</span>
          </p>
          <div className="mt-1 flex items-center gap-1.5">
            <Shield className="text-success h-3.5 w-3.5 shrink-0" />
            <span className="text-muted-foreground text-xs md:text-[13px]">
              <span className="hidden md:inline">
                Every Balo expert is individually vetted &middot; prices in A$ &middot; 100%
                money-back if the first 5 minutes don&apos;t help
              </span>
              <span className="md:hidden">
                Every expert is vetted &middot; money-back guarantee
              </span>
            </span>
          </div>
        </div>

        {/* Desktop controls: grid/list toggle + sort */}
        <div className="hidden shrink-0 items-center gap-2.5 md:flex">
          <div
            className="border-border/60 bg-muted inline-flex gap-0.5 rounded-[9px] border p-[3px]"
            role="group"
            aria-label="Layout"
          >
            {LAYOUT_OPTIONS.map(({ value, Icon, label }) => {
              const active = layout === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-label={label}
                  aria-pressed={active}
                  onClick={() => handleLayout(value)}
                  className={cn(
                    'focus-visible:ring-ring flex h-[30px] w-8 items-center justify-center rounded-[7px] transition-colors focus-visible:ring-2 focus-visible:outline-none',
                    active ? 'bg-card shadow-sm' : 'hover:bg-card/50'
                  )}
                >
                  <Icon
                    className={cn(
                      'h-[15px] w-[15px]',
                      active ? 'text-primary' : 'text-muted-foreground'
                    )}
                  />
                </button>
              );
            })}
          </div>
          <SortDropdown sort={sort} />
        </div>
      </div>

      {/* Mobile controls row: Filters button (+badge) + full-width sort */}
      <div className="mt-3.5 flex gap-2.5 md:hidden">
        <button
          type="button"
          onClick={onOpenFilters}
          className="border-border bg-card text-foreground focus-visible:ring-ring flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] border text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filters
          {activeCount > 0 && (
            <span className="bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold">
              {activeCount}
            </span>
          )}
        </button>
        <div className="flex-1">
          <SortDropdown sort={sort} full />
        </div>
      </div>
    </div>
  );
}
