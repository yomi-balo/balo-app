'use client';

import { useCallback } from 'react';
import { X } from 'lucide-react';
import type { SearchFilters, TimeframeValue } from '@/lib/search/filters';
import { useUpdateSearchParams } from './use-update-search-params';

/** Maps facet ids → display names for chip labels (built from the response facets). */
export interface FacetLabelMaps {
  products: Record<string, string>;
  supportTypes: Record<string, string>;
  languages: Record<string, string>;
}

interface ActiveFilterChipsProps {
  filters: SearchFilters;
  labels: FacetLabelMaps;
}

const TIMEFRAME_LABELS: Record<TimeframeValue, string> = {
  today: 'Available today',
  '3days': 'Within 3 days',
  week: 'Within a week',
};

interface Chip {
  key: string;
  label: string;
  /** Removes just this chip from the URL. */
  onRemove: () => void;
}

export function ActiveFilterChips({
  filters,
  labels,
}: Readonly<ActiveFilterChipsProps>): React.JSX.Element | null {
  const { removeValueFromArray, setParam, clearAll } = useUpdateSearchParams();

  const buildArrayChips = useCallback(
    (key: 'products' | 'supportTypes' | 'languages'): Chip[] =>
      filters[key]
        // Drop unknown ids from the chip display (stale link); they stay in the URL.
        .filter((id) => labels[key][id] !== undefined)
        .map((id) => ({
          key: `${key}:${id}`,
          label: labels[key][id]!,
          onRemove: () => removeValueFromArray(key, id),
        })),
    [filters, labels, removeValueFromArray]
  );

  const chips: Chip[] = [
    ...buildArrayChips('products'),
    ...buildArrayChips('supportTypes'),
    ...buildArrayChips('languages'),
  ];

  if (filters.timeframe) {
    chips.push({
      key: 'timeframe',
      label: TIMEFRAME_LABELS[filters.timeframe],
      onRemove: () => setParam('timeframe', null),
    });
  }
  if (filters.rateMinDollars != null) {
    chips.push({
      key: 'rateMin',
      label: `Min A$${filters.rateMinDollars}/min`,
      onRemove: () => setParam('rateMin', null),
    });
  }
  if (filters.rateMaxDollars != null) {
    chips.push({
      key: 'rateMax',
      label: `Max A$${filters.rateMaxDollars}/min`,
      onRemove: () => setParam('rateMax', null),
    });
  }
  if (filters.q.trim() !== '') {
    chips.push({
      key: 'q',
      label: `"${filters.q}"`,
      onRemove: () => setParam('q', null),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
        Active
      </span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="text-primary border-primary/40 bg-primary/10 inline-flex items-center gap-1.5 rounded-full border py-[5px] pr-[6px] pl-3 text-[13px] font-medium"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`Remove filter ${chip.label}`}
            className="bg-primary/15 hover:bg-primary/25 focus-visible:ring-ring flex h-[18px] w-[18px] items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <X className="h-[11px] w-[11px]" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={clearAll}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring text-[13px] font-medium underline underline-offset-2 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        Clear all
      </button>
    </div>
  );
}
