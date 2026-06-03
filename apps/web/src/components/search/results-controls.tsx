'use client';

import { useCallback, useState } from 'react';
import type { SearchFilters, SortValue } from '@/lib/search/filters';
import type { FacetCountDTO } from '@/lib/search/search-data';
import { ResultsToolbar } from './results-toolbar';
import { FilterSheet } from './filter-sheet';

interface FacetCounts {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}

interface ResultsControlsProps {
  shown: number;
  total: number;
  layout: 'grid' | 'list';
  sort: SortValue;
  activeCount: number;
  filters: SearchFilters;
  facetCounts: FacetCounts;
}

/**
 * Client island that owns the mobile filter-sheet open state and wires the
 * toolbar's "Filters" button to it. Keeps the page a server component while
 * colocating the toolbar + sheet interaction.
 */
export function ResultsControls({
  shown,
  total,
  layout,
  sort,
  activeCount,
  filters,
  facetCounts,
}: Readonly<ResultsControlsProps>): React.JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false);
  const openFilters = useCallback(() => setSheetOpen(true), []);

  return (
    <>
      <ResultsToolbar
        shown={shown}
        total={total}
        layout={layout}
        sort={sort}
        activeCount={activeCount}
        onOpenFilters={openFilters}
      />
      <FilterSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        facetCounts={facetCounts}
        filters={filters}
        total={total}
      />
    </>
  );
}
