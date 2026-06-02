'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { track, SEARCH_EVENTS } from '@/lib/analytics';
import { serializeSearchFilters, type SearchFilters } from '@/lib/search/filters';
import type { FacetCountDTO } from '@/lib/search/search-data';
import { estimatePendingCount } from '@/lib/search/estimate-pending-count';
import { PlaceholderFilterRail } from './placeholder-filter-rail';
import { useUpdateSearchParams } from './use-update-search-params';

interface FacetCounts {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}

interface FilterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facetCounts: FacetCounts;
  /** Current committed filters from the URL (the pending seed). */
  filters: SearchFilters;
  /** Total matching experts (the pending-count baseline). */
  total: number;
}

/**
 * Mobile bottom-sheet filter container. The rail inside runs in PENDING mode —
 * selections are held in local state and committed to the URL only on "Show". The
 * sticky footer count is an optimistic, fetch-free estimate (`estimatePendingCount`);
 * the authoritative count appears once "Show" navigates and the RSC refetches.
 */
export function FilterSheet({
  open,
  onOpenChange,
  facetCounts,
  filters,
  total,
}: Readonly<FilterSheetProps>): React.JSX.Element {
  const { setParams } = useUpdateSearchParams();
  const [pending, setPending] = useState<SearchFilters>(filters);

  // Hold the latest committed filters so the open effect can seed from them
  // without taking `filters` as a dependency (a new identity while the sheet is
  // open must NOT re-seed pending edits or re-fire the analytics event).
  const filtersRef = useRef<SearchFilters>(filters);
  filtersRef.current = filters;

  // Re-seed pending state from the LATEST URL filters once per open transition.
  useEffect(() => {
    if (open) {
      setPending(filtersRef.current);
      track(SEARCH_EVENTS.FILTERS_OPENED, {});
    }
  }, [open]);

  const handleShow = useCallback(() => {
    setParams(serializeSearchFilters({ ...pending, page: 1 }));
    onOpenChange(false);
  }, [pending, setParams, onOpenChange]);

  const count = estimatePendingCount(facetCounts, pending, total);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[82vh] rounded-t-[20px]" aria-label="Filters">
        <SheetHeader className="border-border/60 border-b">
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription className="sr-only">
            Refine the expert search by skill, support type, language, rate, and availability.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-2">
          <PlaceholderFilterRail
            facetCounts={facetCounts}
            filters={pending}
            onPendingChange={setPending}
          />
        </div>

        <SheetFooter className="border-border/60 border-t">
          <button
            type="button"
            onClick={handleShow}
            className="from-primary focus-visible:ring-ring flex h-12 w-full items-center justify-center rounded-xl bg-gradient-to-r to-violet-600 text-[15px] font-semibold text-white shadow-sm transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:outline-none dark:to-violet-500"
          >
            Show {count} {count === 1 ? 'expert' : 'experts'}
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
