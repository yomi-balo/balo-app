'use client';

import { useCallback, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { SearchFilters } from '@/lib/search/filters';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { FacetCountDTO } from '@/lib/search/search-data';
import { FilterSheet } from '../filter-sheet';
import { TIMEFRAME_OPTIONS } from './constants';

interface FacetCounts {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}

interface MobileComposerBarProps {
  filters: SearchFilters;
  taxonomy: ProductTaxonomy;
  facetCounts: FacetCounts;
  productNameMap: Record<string, string>;
  total: number;
}

/**
 * Mobile collapsed summary bar (one-trigger): a single field showing the active
 * query/filter summary + an active-count badge. Tapping it opens the shared
 * `FilterSheet` (FTS field at the top + all facets + "Show N" commit).
 */
export function MobileComposerBar({
  filters,
  taxonomy,
  facetCounts,
  productNameMap,
  total,
}: Readonly<MobileComposerBarProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const openSheet = useCallback(() => setOpen(true), []);

  const summary = useMemo(() => {
    const parts: string[] = [];
    if (filters.products.length > 0) {
      const first = productNameMap[filters.products[0]!] ?? filters.products[0]!;
      parts.push(filters.products.length > 1 ? `${first} +${filters.products.length - 1}` : first);
    }
    const supportMap = Object.fromEntries(facetCounts.supportTypes.map((f) => [f.id, f.name]));
    if (filters.supportTypes.length > 0) {
      parts.push(supportMap[filters.supportTypes[0]!] ?? filters.supportTypes[0]!);
    }
    if (filters.timeframe) {
      const label = TIMEFRAME_OPTIONS.find((t) => t.value === filters.timeframe)?.label;
      if (label) parts.push(label);
    }
    return parts.join(' · ');
  }, [
    filters.products,
    filters.supportTypes,
    filters.timeframe,
    productNameMap,
    facetCounts.supportTypes,
  ]);

  const activeCount =
    filters.products.length +
    filters.supportTypes.length +
    filters.languages.length +
    (filters.timeframe ? 1 : 0) +
    (filters.rateMinDollars != null ? 1 : 0) +
    (filters.rateMaxDollars != null ? 1 : 0);

  const placeholder = filters.q.trim() !== '' ? filters.q : 'Search or filter experts';

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        aria-label="Search and filter experts"
        className="bg-card border-border flex w-full items-center gap-3 rounded-2xl border px-4 py-3.5 text-left shadow-sm"
      >
        <Search className="text-muted-foreground h-[19px] w-[19px] shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          {summary !== '' ? (
            <>
              <span className="text-muted-foreground truncate text-[11px] leading-tight">
                {placeholder}
              </span>
              <span className="text-foreground truncate text-sm leading-snug font-semibold">
                {summary}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground text-[15px]">{placeholder}</span>
          )}
        </span>
        {activeCount > 0 && (
          <span className="bg-primary text-primary-foreground flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-xs font-bold">
            {activeCount}
          </span>
        )}
      </button>

      <FilterSheet
        open={open}
        onOpenChange={setOpen}
        facetCounts={facetCounts}
        filters={filters}
        total={total}
        taxonomy={taxonomy}
        productNameMap={productNameMap}
      />
    </>
  );
}
