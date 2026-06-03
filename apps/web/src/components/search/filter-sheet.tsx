'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
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
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import {
  buildSearchSnapshot,
  deriveSearchPath,
  type ComposerNameMaps,
} from '@/lib/search/composer-analytics';
import { estimatePendingCount } from '@/lib/search/estimate-pending-count';
import { FacetControls } from './composer/facet-controls';
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
  /** Browsable product taxonomy for the in-sheet ProductSelector. */
  taxonomy: ProductTaxonomy;
  /** Authoritative product id→name map (taxonomy-backed). */
  productNameMap: Record<string, string>;
}

function facetMap(facets: FacetCountDTO[]): Record<string, string> {
  return Object.fromEntries(facets.map((f) => [f.id, f.name]));
}

/**
 * Mobile bottom-sheet filter container (one-trigger model). FTS field at the top
 * + the shared `FacetControls` in PENDING mode — nothing hits the URL until
 * "Show", which commits and fires `search_submitted` (surface `mobile_sheet`).
 * The sticky footer count is the optimistic, fetch-free `estimatePendingCount`.
 */
export function FilterSheet({
  open,
  onOpenChange,
  facetCounts,
  filters,
  total,
  taxonomy,
  productNameMap,
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

  const setPendingQuery = useCallback((q: string) => {
    setPending((prev) => ({ ...prev, q }));
  }, []);

  const handleShow = useCallback(() => {
    const committed: SearchFilters = { ...pending, page: 1 };
    setParams(serializeSearchFilters(committed));
    const nameMaps: ComposerNameMaps = {
      products: productNameMap,
      supportTypes: facetMap(facetCounts.supportTypes),
      languages: facetMap(facetCounts.languages),
    };
    const snapshot = buildSearchSnapshot(committed, nameMaps);
    track(SEARCH_EVENTS.SUBMITTED, {
      ...snapshot,
      surface: 'mobile_sheet',
      path: deriveSearchPath(snapshot),
    });
    onOpenChange(false);
  }, [
    pending,
    setParams,
    onOpenChange,
    productNameMap,
    facetCounts.supportTypes,
    facetCounts.languages,
  ]);

  const count = estimatePendingCount(facetCounts, pending, total);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[88vh] rounded-t-[20px]" aria-label="Filters">
        <SheetHeader className="border-border/60 border-b">
          <SheetTitle>Search &amp; filter</SheetTitle>
          <SheetDescription className="sr-only">
            Search by keyword and refine by skill, support type, language, rate, and availability.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-2">
          <div className="border-border/60 border-b py-[18px]">
            <div className="mb-3 flex items-center gap-2">
              <Search className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
              <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
                Search
              </span>
            </div>
            <div className="border-border bg-card focus-within:border-ring focus-within:ring-ring/30 flex h-11 items-center gap-2.5 rounded-[11px] border px-3.5 transition-shadow focus-within:ring-[3px]">
              <Search className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
              <label htmlFor="sheet-q" className="sr-only">
                Search experts by product, skill, or name
              </label>
              <input
                id="sheet-q"
                value={pending.q}
                onChange={(e) => setPendingQuery(e.target.value)}
                placeholder="Search by product, skill, or name — e.g. Agentforce"
                className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </div>
          </div>

          <div className="pt-[18px]">
            <FacetControls
              mode="pending"
              taxonomy={taxonomy}
              facetCounts={facetCounts}
              productNameMap={productNameMap}
              filters={pending}
              onPendingChange={setPending}
              productSurface="sheet"
              inSheet
            />
          </div>
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
