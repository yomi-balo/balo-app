'use client';

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Search, Package, Wrench, Clock } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { track, SEARCH_EVENTS } from '@/lib/analytics';
import type { SearchFilters } from '@/lib/search/filters';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { FacetCountDTO } from '@/lib/search/search-data';
import {
  buildSearchSnapshot,
  deriveSearchPath,
  type ComposerNameMaps,
} from '@/lib/search/composer-analytics';
import { useUpdateSearchParams } from '../use-update-search-params';
import { BarSegment } from './bar-segment';
import { PillRow, type PillOption } from './pill-row';
import { ProductSelector } from './product-selector';
import { TIMEFRAME_OPTIONS, ANY_TIMEFRAME } from './constants';
import { useFacetRequery } from './use-facet-requery';
import { useFacetSelection } from './use-facet-selection';

interface FacetCounts {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}

interface UnifiedBarProps {
  /** `hero` = tall + "Search" text; `compact` = short + icon-only CTA. */
  variant: 'hero' | 'compact';
  filters: SearchFilters;
  taxonomy: ProductTaxonomy;
  facetCounts: FacetCounts;
  productNameMap: Record<string, string>;
  nameMaps: ComposerNameMaps;
  hasResults: boolean;
}

function summarize(ids: string[], nameMap: Record<string, string>): string | null {
  if (ids.length === 0) return null;
  const first = nameMap[ids[0]!] ?? ids[0]!;
  return ids.length === 1 ? first : `${first} +${ids.length - 1}`;
}

function summarizeSupport(ids: string[], nameMap: Record<string, string>): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return nameMap[ids[0]!] ?? ids[0]!;
  return `${ids.length} selected`;
}

function facetsToPillOptions(facets: FacetCountDTO[]): PillOption[] {
  return facets.map((facet) => ({ value: facet.id, label: facet.name }));
}

/**
 * Desktop unified segmented bar: FTS input + Product/Support/When popover segments
 * + Search CTA. FTS is an explicit submit on every variant (Enter or the button);
 * facet popover toggles re-query live (debounced) only when results are present —
 * identical behaviour to the rail (both via `useFacetRequery`).
 */
export function UnifiedBar({
  variant,
  filters,
  taxonomy,
  facetCounts,
  productNameMap,
  nameMaps,
  hasResults,
}: Readonly<UnifiedBarProps>): React.JSX.Element {
  const compact = variant === 'compact';
  const { setParam } = useUpdateSearchParams();
  const requery = useFacetRequery({ hasResults, surface: 'compact_bar', nameMaps });
  // Local mirror so popover toggles paint instantly; the URL stays the source of
  // truth (committed sink = the debounced `useFacetRequery`).
  const {
    values,
    toggleArray,
    setTimeframe,
    clearProducts: clearSelection,
  } = useFacetSelection({
    filters,
    sink: { mode: 'committed', requery },
  });
  const [query, setQuery] = useState(filters.q);
  const [openSegment, setOpenSegment] = useState<'product' | 'support' | 'when' | null>(null);

  const selectedProducts = useMemo(() => new Set(values.products), [values.products]);
  const selectedSupport = useMemo(() => new Set(values.supportTypes), [values.supportTypes]);
  const selectedTimeframe = useMemo(
    () => new Set([values.timeframe ?? ANY_TIMEFRAME]),
    [values.timeframe]
  );

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = query.trim();
      setParam('q', trimmed === '' ? null : trimmed);
      const snapshot = buildSearchSnapshot({ ...filters, q: trimmed }, nameMaps);
      track(SEARCH_EVENTS.SUBMITTED, {
        ...snapshot,
        surface: compact ? 'compact_bar' : 'hero_bar',
        path: deriveSearchPath(snapshot),
      });
    },
    [query, setParam, filters, nameMaps, compact]
  );

  const toggleProduct = useCallback((id: string) => toggleArray('products', id), [toggleArray]);
  const clearProducts = useCallback(() => {
    clearSelection();
    track(SEARCH_EVENTS.COMPOSER_CLEARED, { surface: compact ? 'compact_bar' : 'hero_bar' });
  }, [clearSelection, compact]);
  const toggleSupport = useCallback((id: string) => toggleArray('supportTypes', id), [toggleArray]);
  const selectTimeframe = useCallback(
    (value: string) => {
      setTimeframe(value);
      setOpenSegment(null);
    },
    [setTimeframe]
  );

  const productSummary = summarize(values.products, productNameMap);
  const supportMap = useMemo(
    () => Object.fromEntries(facetCounts.supportTypes.map((f) => [f.id, f.name])),
    [facetCounts.supportTypes]
  );
  const supportSummary = summarizeSupport(values.supportTypes, supportMap);
  const timeframeSummary =
    TIMEFRAME_OPTIONS.find((t) => t.value === values.timeframe)?.label ?? null;

  const onSegmentOpenChange = useCallback(
    (segment: 'product' | 'support' | 'when', open: boolean) => {
      // The product popover mounts ProductSelector with `collapsible={false}`, so
      // the selector's own header never fires "opened" — emit it here on the
      // open transition instead.
      if (segment === 'product' && open && openSegment !== 'product') {
        track(SEARCH_EVENTS.PRODUCT_SELECTOR_OPENED, { surface: 'popover' });
      }
      setOpenSegment(open ? segment : null);
    },
    [openSegment]
  );

  return (
    <form
      onSubmit={handleSubmit}
      role="search"
      className={cn(
        'bg-card border-border flex items-center rounded-2xl border',
        compact ? 'h-14 shadow-sm' : 'shadow-primary/5 h-[68px] shadow-lg'
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 px-4.5">
        <Search className="text-muted-foreground h-[18px] w-[18px] shrink-0" aria-hidden />
        <label htmlFor="composer-q" className="sr-only">
          Search experts by product, skill, or name
        </label>
        <input
          id="composer-q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by product, skill, or name — e.g. Agentforce, CPQ"
          className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[15px] outline-none"
        />
      </div>

      <div className="bg-border/70 my-2.5 w-px self-stretch" aria-hidden />

      <Popover
        open={openSegment === 'product'}
        onOpenChange={(open) => onSegmentOpenChange('product', open)}
      >
        <PopoverTrigger asChild>
          <span className="h-full">
            <BarSegment
              icon={Package}
              label="Product"
              summary={productSummary}
              placeholder="Any"
              active={openSegment === 'product'}
              onClick={() => onSegmentOpenChange('product', openSegment !== 'product')}
            />
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[440px] p-4">
          <ProductSelector
            taxonomy={taxonomy}
            selectedIds={selectedProducts}
            nameMap={productNameMap}
            onToggle={toggleProduct}
            onClear={clearProducts}
            surface="popover"
            onSearched={(had_results) =>
              track(SEARCH_EVENTS.PRODUCT_SELECTOR_SEARCHED, { had_results })
            }
            onGroupExpanded={(group) => track(SEARCH_EVENTS.PRODUCT_GROUP_EXPANDED, { group })}
          />
        </PopoverContent>
      </Popover>

      <div className="bg-border/70 my-2.5 w-px self-stretch" aria-hidden />

      <Popover
        open={openSegment === 'support'}
        onOpenChange={(open) => onSegmentOpenChange('support', open)}
      >
        <PopoverTrigger asChild>
          <span className="h-full">
            <BarSegment
              icon={Wrench}
              label="Support"
              summary={supportSummary}
              placeholder="Any"
              active={openSegment === 'support'}
              onClick={() => onSegmentOpenChange('support', openSegment !== 'support')}
            />
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[300px] p-4">
          <p className="text-muted-foreground mb-3 text-[11px] font-bold tracking-wide uppercase">
            Type of help
          </p>
          <PillRow
            options={facetsToPillOptions(facetCounts.supportTypes)}
            selected={selectedSupport}
            onToggle={toggleSupport}
            ariaLabel="Support type"
          />
        </PopoverContent>
      </Popover>

      <div className="bg-border/70 my-2.5 w-px self-stretch" aria-hidden />

      <Popover
        open={openSegment === 'when'}
        onOpenChange={(open) => onSegmentOpenChange('when', open)}
      >
        <PopoverTrigger asChild>
          <span className="h-full">
            <BarSegment
              icon={Clock}
              label="When"
              summary={timeframeSummary}
              placeholder="Any time"
              active={openSegment === 'when'}
              onClick={() => onSegmentOpenChange('when', openSegment !== 'when')}
            />
          </span>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[260px] p-4">
          <p className="text-muted-foreground mb-3 text-[11px] font-bold tracking-wide uppercase">
            Available within
          </p>
          <PillRow
            options={TIMEFRAME_OPTIONS}
            selected={selectedTimeframe}
            onToggle={selectTimeframe}
            ariaLabel="Availability"
          />
        </PopoverContent>
      </Popover>

      <div className={cn('pr-2.5', compact ? 'pl-1' : 'pl-1.5')}>
        <button
          type="submit"
          className={cn(
            'from-primary focus-visible:ring-ring flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r to-violet-600 font-semibold text-white shadow-sm transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:outline-none dark:to-violet-500',
            compact ? 'h-10 px-4.5' : 'h-12 px-5.5'
          )}
        >
          <Search className="h-4 w-4" aria-hidden />
          {!compact && 'Search'}
          {compact && <span className="sr-only">Search</span>}
        </button>
      </div>
    </form>
  );
}
