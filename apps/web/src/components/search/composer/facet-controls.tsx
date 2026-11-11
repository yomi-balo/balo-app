'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Wrench, Clock, DollarSign, Globe, type LucideProps } from 'lucide-react';
import { track, SEARCH_EVENTS, type SearchClearableFacet } from '@/lib/analytics';
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

/** Short name per clearable facet, used for the Clear control's accessible name and its announcement. */
const CLEAR_LABELS: Record<SearchClearableFacet, string> = {
  support_types: 'Type of help',
  timeframe: 'Availability',
  rate: 'Rate',
  languages: 'Languages',
};

/** How long the "filter cleared" announcement stays in the live region before it resets. */
const ANNOUNCEMENT_RESET_MS = 3000;

function Section({
  icon: Icon,
  label,
  clearLabel = label,
  onClear,
  bordered = true,
  children,
}: Readonly<{
  icon: ComponentType<LucideProps>;
  label: string;
  /** Short name in the Clear control's accessible name when `label` is long ("Rate"). */
  clearLabel?: string;
  /** Rendered only when the section has a selection to clear. */
  onClear?: () => void;
  bordered?: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  const headingRef = useRef<HTMLDivElement>(null);

  const handleClear = useCallback(() => {
    onClear?.();
    // The button unmounts once the selection empties; keep focus inside the section.
    headingRef.current?.focus();
  }, [onClear]);

  return (
    <div className={bordered ? 'border-border/60 border-b pb-[18px]' : undefined}>
      <div
        ref={headingRef}
        tabIndex={-1}
        className="focus-visible:ring-ring mb-3.5 flex h-4 items-center gap-2 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        <Icon className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
        <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
          {label}
        </span>
        {onClear && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={`Clear ${clearLabel}`}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -my-3.5 ml-auto inline-flex min-h-11 items-center px-1 text-xs font-medium underline underline-offset-2 transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            Clear
          </button>
        )}
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
  const {
    values,
    toggleArray,
    setTimeframe,
    setRate,
    clearArray,
    clearProducts: clearSelection,
  } = selection;

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

  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!announcement) return undefined;
    const timer = setTimeout(() => setAnnouncement(''), ANNOUNCEMENT_RESET_MS);
    return () => clearTimeout(timer);
  }, [announcement]);

  const clearSection = useCallback(
    (facet: SearchClearableFacet) => {
      switch (facet) {
        case 'support_types':
          clearArray('supportTypes');
          break;
        case 'timeframe':
          setTimeframe(ANY_TIMEFRAME);
          break;
        case 'rate':
          setRate({ min: null, max: null });
          break;
        case 'languages':
          clearArray('languages');
          break;
      }
      track(SEARCH_EVENTS.FACET_CLEARED, { facet, surface: inSheet ? 'sheet' : 'rail' });
      setAnnouncement(`${CLEAR_LABELS[facet]} filter cleared`);
    },
    [clearArray, setTimeframe, setRate, inSheet]
  );
  const clearSupportTypes = useCallback(() => clearSection('support_types'), [clearSection]);
  const clearTimeframe = useCallback(() => clearSection('timeframe'), [clearSection]);
  const clearRate = useCallback(() => clearSection('rate'), [clearSection]);
  const clearLanguages = useCallback(() => clearSection('languages'), [clearSection]);

  const hasRate = values.rateMinDollars !== null || values.rateMaxDollars !== null;

  return (
    <div className="space-y-[18px] text-sm">
      <span role="status" className="sr-only">
        {announcement}
      </span>
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

      <Section
        icon={Wrench}
        label="Type of help"
        onClear={values.supportTypes.length > 0 ? clearSupportTypes : undefined}
      >
        <PillRow
          options={facetsToPillOptions(facetCounts.supportTypes)}
          selected={selectedSupport}
          onToggle={(id) => toggleArray('supportTypes', id)}
          ariaLabel="Support type"
        />
      </Section>

      <Section
        icon={Clock}
        label="Availability"
        onClear={values.timeframe === null ? undefined : clearTimeframe}
      >
        <PillRow
          options={TIMEFRAME_OPTIONS}
          selected={selectedTimeframe}
          onToggle={setTimeframe}
          ariaLabel="Availability"
        />
      </Section>

      <Section
        icon={DollarSign}
        label="Rate (A$ per minute)"
        clearLabel={CLEAR_LABELS.rate}
        onClear={hasRate ? clearRate : undefined}
      >
        <RateRangeSlider
          rateMinDollars={values.rateMinDollars}
          rateMaxDollars={values.rateMaxDollars}
          onCommit={setRate}
        />
      </Section>

      <Section
        icon={Globe}
        label="Languages"
        bordered={false}
        onClear={values.languages.length > 0 ? clearLanguages : undefined}
      >
        <PillRow
          options={facetsToPillOptions(facetCounts.languages)}
          selected={selectedLanguages}
          onToggle={(id) => toggleArray('languages', id)}
          ariaLabel="Languages"
        />
      </Section>
    </div>
  );
}
