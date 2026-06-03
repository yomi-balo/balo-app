'use client';

import { useCallback, useMemo, type ComponentType } from 'react';
import { Wrench, Clock, DollarSign, Globe, type LucideProps } from 'lucide-react';
import { track, SEARCH_EVENTS } from '@/lib/analytics';
import type { SearchFilters, TimeframeValue } from '@/lib/search/filters';
import { TIMEFRAME_VALUES } from '@/lib/search/filters';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { FacetCountDTO } from '@/lib/search/search-data';
import type { ComposerNameMaps } from '@/lib/search/composer-analytics';
import { PillRow, type PillOption } from './pill-row';
import { ProductSelector, type ProductSelectorSurface } from './product-selector';
import { RateRangeSlider } from './rate-range-slider';
import { TIMEFRAME_OPTIONS, ANY_TIMEFRAME } from './constants';
import { useFacetRequery, type RefineSurface } from './use-facet-requery';

interface FacetCounts {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}

interface FacetControlsProps {
  /** `committed` writes the URL (rail); `pending` lifts to `onPendingChange` (sheet). */
  mode: 'committed' | 'pending';
  taxonomy: ProductTaxonomy;
  facetCounts: FacetCounts;
  productNameMap: Record<string, string>;
  /** Current values to reflect (URL filters when committed; pending in the sheet). */
  filters: SearchFilters;
  /** Required in pending mode — changes report here instead of writing the URL. */
  onPendingChange?: (next: SearchFilters) => void;
  /** Whether results are present (gates the live-requery `search_refined`). */
  hasResults?: boolean;
  /** Surface for refine analytics (committed mode) / open analytics. */
  refineSurface?: RefineSurface;
  productSurface: ProductSelectorSurface;
  /** Lifts the ProductSelector inner scroll cap (sheet). */
  inSheet?: boolean;
}

function facetsToPillOptions(facets: FacetCountDTO[]): PillOption[] {
  return facets.map((facet) => ({ value: facet.id, label: facet.name }));
}

function buildNameMaps(
  productNameMap: Record<string, string>,
  facetCounts: FacetCounts
): ComposerNameMaps {
  const toMap = (facets: FacetCountDTO[]): Record<string, string> =>
    Object.fromEntries(facets.map((f) => [f.id, f.name]));
  return {
    products: productNameMap,
    supportTypes: toMap(facetCounts.supportTypes),
    languages: toMap(facetCounts.languages),
  };
}

function Section({
  icon: Icon,
  label,
  children,
}: Readonly<{
  icon: ComponentType<LucideProps>;
  label: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="border-border/60 border-b pb-[18px]">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
        <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * The shared facet body mounted in BOTH the desktop rail and the mobile sheet —
 * one component so they cannot drift. Committed mode routes every change through
 * `useFacetRequery` (debounced URL write + `search_refined`); pending mode reports
 * to `onPendingChange` and never touches the URL or fires refine analytics.
 */
export function FacetControls({
  mode,
  taxonomy,
  facetCounts,
  productNameMap,
  filters,
  onPendingChange,
  hasResults = false,
  refineSurface = 'rail',
  productSurface,
  inSheet = false,
}: Readonly<FacetControlsProps>): React.JSX.Element {
  const isPending = mode === 'pending';
  // Every committed write — including clear-products — routes through the
  // debounced `useFacetRequery` so the rail and compact bar behave identically.
  const nameMaps = useMemo(
    () => buildNameMaps(productNameMap, facetCounts),
    [productNameMap, facetCounts]
  );
  const requery = useFacetRequery({ hasResults, surface: refineSurface, nameMaps });

  const selectedProducts = useMemo(() => new Set(filters.products), [filters.products]);
  const selectedSupport = useMemo(() => new Set(filters.supportTypes), [filters.supportTypes]);
  const selectedLanguages = useMemo(() => new Set(filters.languages), [filters.languages]);
  const selectedTimeframe = useMemo(
    () => new Set([filters.timeframe ?? ANY_TIMEFRAME]),
    [filters.timeframe]
  );

  const toggleArray = useCallback(
    (key: 'products' | 'supportTypes' | 'languages', id: string) => {
      const checked = !filters[key].includes(id);
      if (isPending) {
        const current = filters[key];
        const next = checked ? [...current, id] : current.filter((v) => v !== id);
        onPendingChange?.({ ...filters, [key]: next });
        return;
      }
      requery.setArrayValue(key, id, checked);
    },
    [isPending, filters, onPendingChange, requery]
  );

  const toggleTimeframe = useCallback(
    (value: string) => {
      const next: TimeframeValue | null = (TIMEFRAME_VALUES as readonly string[]).includes(value)
        ? (value as TimeframeValue)
        : null;
      if (isPending) {
        onPendingChange?.({ ...filters, timeframe: next });
        return;
      }
      requery.setTimeframe(value);
    },
    [isPending, filters, onPendingChange, requery]
  );

  const commitRate = useCallback(
    (next: { min: number | null; max: number | null }) => {
      if (isPending) {
        onPendingChange?.({ ...filters, rateMinDollars: next.min, rateMaxDollars: next.max });
        return;
      }
      requery.setRate(next);
    },
    [isPending, filters, onPendingChange, requery]
  );

  const clearProducts = useCallback(() => {
    if (isPending) {
      onPendingChange?.({ ...filters, products: [] });
    } else {
      // Single navigation: the buffered setters in `useFacetRequery` mutate one
      // `URLSearchParams` and commit a single debounced `router.replace`, matching
      // `UnifiedBar.clearProducts` and the plan's single-navigation-commit rule.
      for (const id of filters.products) requery.setArrayValue('products', id, false);
    }
    track(SEARCH_EVENTS.COMPOSER_CLEARED, { surface: inSheet ? 'sheet' : 'rail' });
  }, [isPending, filters, onPendingChange, requery, inSheet]);

  return (
    <div className="space-y-[18px] text-sm">
      <div className="border-border/60 border-b pb-[18px]">
        <ProductSelector
          taxonomy={taxonomy}
          selectedIds={selectedProducts}
          nameMap={productNameMap}
          onToggle={(id) => toggleArray('products', id)}
          onClear={clearProducts}
          collapsible
          inSheet={inSheet}
          surface={productSurface}
          onOpened={(surface) => track(SEARCH_EVENTS.PRODUCT_SELECTOR_OPENED, { surface })}
          onSearched={(had_results) =>
            track(SEARCH_EVENTS.PRODUCT_SELECTOR_SEARCHED, { had_results })
          }
          onGroupExpanded={(group) => track(SEARCH_EVENTS.PRODUCT_GROUP_EXPANDED, { group })}
        />
      </div>

      <Section icon={Wrench} label="Type of help">
        <PillRow
          options={facetsToPillOptions(facetCounts.supportTypes)}
          selected={selectedSupport}
          onToggle={(id) => toggleArray('supportTypes', id)}
          ariaLabel="Support type"
        />
      </Section>

      <Section icon={Clock} label="Availability">
        <PillRow
          options={TIMEFRAME_OPTIONS}
          selected={selectedTimeframe}
          onToggle={toggleTimeframe}
          ariaLabel="Availability"
        />
      </Section>

      <Section icon={DollarSign} label="Rate (A$ per minute)">
        <RateRangeSlider
          rateMinDollars={filters.rateMinDollars}
          rateMaxDollars={filters.rateMaxDollars}
          onCommit={commitRate}
        />
      </Section>

      <div>
        <div className="mb-3 flex items-center gap-2">
          <Globe className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
          <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
            Languages
          </span>
        </div>
        <PillRow
          options={facetsToPillOptions(facetCounts.languages)}
          selected={selectedLanguages}
          onToggle={(id) => toggleArray('languages', id)}
          ariaLabel="Languages"
        />
      </div>
    </div>
  );
}
