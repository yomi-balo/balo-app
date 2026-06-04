'use client';

import { useCallback, useMemo, type ComponentType } from 'react';
import { Wrench, Clock, DollarSign, Globe, type LucideProps } from 'lucide-react';
import { track, SEARCH_EVENTS } from '@/lib/analytics';
import type { SearchFilters } from '@/lib/search/filters';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { FacetCountDTO } from '@/lib/search/search-data';
import type { ComposerNameMaps } from '@/lib/search/composer-analytics';
import { PillRow, type PillOption } from './pill-row';
import { ProductSelector, type ProductSelectorSurface } from './product-selector';
import { RateRangeSlider } from './rate-range-slider';
import { TIMEFRAME_OPTIONS, ANY_TIMEFRAME } from './constants';
import { useFacetRequery, type RefineSurface } from './use-facet-requery';
import { useFacetSelection } from './use-facet-selection';

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

  // The local mirror paints selection instantly on click; `useFacetRequery`
  // (committed) / `onPendingChange` (pending) remains the sink and the URL/pending
  // state remains the source of truth, reconciled back over the mirror when settled.
  const selection = useFacetSelection({
    filters,
    sink: isPending
      ? { mode: 'pending', filters, onPendingChange: onPendingChange ?? (() => undefined) }
      : { mode: 'committed', requery },
  });
  const { values, toggleArray, setTimeframe, setRate, clearProducts: clearSelection } = selection;

  const selectedProducts = useMemo(() => new Set(values.products), [values.products]);
  const selectedSupport = useMemo(() => new Set(values.supportTypes), [values.supportTypes]);
  const selectedLanguages = useMemo(() => new Set(values.languages), [values.languages]);
  const selectedTimeframe = useMemo(
    () => new Set([values.timeframe ?? ANY_TIMEFRAME]),
    [values.timeframe]
  );

  const clearProducts = useCallback(() => {
    clearSelection();
    track(SEARCH_EVENTS.COMPOSER_CLEARED, { surface: inSheet ? 'sheet' : 'rail' });
  }, [clearSelection, inSheet]);

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
          onToggle={setTimeframe}
          ariaLabel="Availability"
        />
      </Section>

      <Section icon={DollarSign} label="Rate (A$ per minute)">
        <RateRangeSlider
          rateMinDollars={values.rateMinDollars}
          rateMaxDollars={values.rateMaxDollars}
          onCommit={setRate}
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
