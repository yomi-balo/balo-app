'use client';

// PLACEHOLDER — replaced by the search composer ticket. Do not invest in styling.
// Plain native controls (checkboxes, number inputs, native select) that ONLY read
// facet options from `facetCounts` and write filter state. In committed mode
// (desktop) it writes straight to the URL; in pending mode (mobile sheet) it lifts
// state to the parent and commits on "Show".

import { useCallback } from 'react';
import type { FacetCountDTO } from '@/lib/search/search-data';
import { TIMEFRAME_VALUES, type SearchFilters, type TimeframeValue } from '@/lib/search/filters';
import { useUpdateSearchParams } from './use-update-search-params';

interface FacetCounts {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}

interface PlaceholderFilterRailProps {
  facetCounts: FacetCounts;
  /** Current values to reflect (URL filters on desktop; pending filters in sheet). */
  filters: SearchFilters;
  /**
   * Pending mode: when provided, changes are reported here instead of written to
   * the URL (the sheet commits on "Show"). When omitted, changes write the URL.
   */
  onPendingChange?: (next: SearchFilters) => void;
}

const TIMEFRAME_OPTION_LABELS: Record<TimeframeValue, string> = {
  today: 'Available today',
  '3days': 'Within 3 days',
  week: 'Within a week',
};

type ArrayFacetKey = 'products' | 'supportTypes' | 'languages';

const SECTIONS: ReadonlyArray<{ key: ArrayFacetKey; label: string }> = [
  { key: 'products', label: 'Skills' },
  { key: 'supportTypes', label: 'Support type' },
  { key: 'languages', label: 'Languages' },
];

export function PlaceholderFilterRail({
  facetCounts,
  filters,
  onPendingChange,
}: Readonly<PlaceholderFilterRailProps>): React.JSX.Element {
  const { addValueToArray, removeValueFromArray, setParam } = useUpdateSearchParams();
  const isPending = onPendingChange !== undefined;

  const toggleArrayValue = useCallback(
    (key: ArrayFacetKey, id: string, checked: boolean) => {
      if (isPending) {
        const current = filters[key];
        const next = checked ? [...current, id] : current.filter((v) => v !== id);
        onPendingChange({ ...filters, [key]: next });
        return;
      }
      if (checked) {
        addValueToArray(key, id);
      } else {
        removeValueFromArray(key, id);
      }
    },
    [isPending, filters, onPendingChange, addValueToArray, removeValueFromArray]
  );

  const setRate = useCallback(
    (bound: 'rateMinDollars' | 'rateMaxDollars', raw: string) => {
      const value = raw.trim() === '' ? null : Number(raw);
      const normalized = value != null && Number.isFinite(value) && value >= 0 ? value : null;
      if (isPending) {
        onPendingChange({ ...filters, [bound]: normalized });
        return;
      }
      setParam(bound === 'rateMinDollars' ? 'rateMin' : 'rateMax', normalized?.toString() ?? null);
    },
    [isPending, filters, onPendingChange, setParam]
  );

  const setTimeframe = useCallback(
    (raw: string) => {
      const value = (TIMEFRAME_VALUES as readonly string[]).includes(raw)
        ? (raw as TimeframeValue)
        : null;
      if (isPending) {
        onPendingChange({ ...filters, timeframe: value });
        return;
      }
      setParam('timeframe', value);
    },
    [isPending, filters, onPendingChange, setParam]
  );

  return (
    <div className="space-y-6 text-sm">
      {SECTIONS.map((section) => (
        <fieldset key={section.key} className="border-border/60 border-b pb-5">
          <legend className="text-muted-foreground mb-2.5 text-[11px] font-bold tracking-wide uppercase">
            {section.label}
          </legend>
          <div className="space-y-1.5">
            {facetCounts[section.key].length === 0 && (
              <p className="text-muted-foreground text-xs">No options</p>
            )}
            {facetCounts[section.key].map((facet) => {
              const id = `${isPending ? 'pending' : 'rail'}-${section.key}-${facet.id}`;
              const checked = filters[section.key].includes(facet.id);
              return (
                <label
                  key={facet.id}
                  htmlFor={id}
                  className="text-muted-foreground flex cursor-pointer items-center gap-2"
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggleArrayValue(section.key, facet.id, e.target.checked)}
                    className="accent-primary h-4 w-4"
                  />
                  <span className="flex-1">{facet.name}</span>
                  <span className="text-muted-foreground/70 text-xs">{facet.count}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}

      <fieldset className="border-border/60 border-b pb-5">
        <legend className="text-muted-foreground mb-2.5 text-[11px] font-bold tracking-wide uppercase">
          Rate (A$ per minute)
        </legend>
        <div className="flex items-center gap-2">
          <label htmlFor={`${isPending ? 'pending' : 'rail'}-rateMin`} className="sr-only">
            Minimum rate in A$ per minute
          </label>
          <input
            id={`${isPending ? 'pending' : 'rail'}-rateMin`}
            type="number"
            min={0}
            placeholder="Min"
            value={filters.rateMinDollars ?? ''}
            onChange={(e) => setRate('rateMinDollars', e.target.value)}
            className="border-border bg-card w-full rounded-md border px-2 py-1.5"
          />
          <span className="text-muted-foreground">&ndash;</span>
          <label htmlFor={`${isPending ? 'pending' : 'rail'}-rateMax`} className="sr-only">
            Maximum rate in A$ per minute
          </label>
          <input
            id={`${isPending ? 'pending' : 'rail'}-rateMax`}
            type="number"
            min={0}
            placeholder="Max"
            value={filters.rateMaxDollars ?? ''}
            onChange={(e) => setRate('rateMaxDollars', e.target.value)}
            className="border-border bg-card w-full rounded-md border px-2 py-1.5"
          />
        </div>
      </fieldset>

      <div>
        <label
          htmlFor={`${isPending ? 'pending' : 'rail'}-timeframe`}
          className="text-muted-foreground mb-2.5 block text-[11px] font-bold tracking-wide uppercase"
        >
          Availability
        </label>
        <select
          id={`${isPending ? 'pending' : 'rail'}-timeframe`}
          value={filters.timeframe ?? ''}
          onChange={(e) => setTimeframe(e.target.value)}
          className="border-border bg-card w-full rounded-md border px-2 py-1.5"
        >
          <option value="">Any time</option>
          {TIMEFRAME_VALUES.map((tf) => (
            <option key={tf} value={tf}>
              {TIMEFRAME_OPTION_LABELS[tf]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
