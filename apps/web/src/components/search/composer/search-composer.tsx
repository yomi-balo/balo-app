'use client';

import { useMemo } from 'react';
import type { SearchFilters } from '@/lib/search/filters';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { FacetCountDTO } from '@/lib/search/search-data';
import type { ComposerNameMaps } from '@/lib/search/composer-analytics';
import { UnifiedBar } from './unified-bar';
import { MobileComposerBar } from './mobile-composer-bar';

interface FacetCounts {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}

interface SearchComposerProps {
  /** Parsed filters from the URL (RSC). */
  filters: SearchFilters;
  taxonomy: ProductTaxonomy;
  facetCounts: FacetCounts;
  /** Authoritative product id→name map (taxonomy-backed). */
  productNameMap: Record<string, string>;
  /** Total matching experts (mobile-sheet "Show N" baseline). */
  total: number;
  /** `hero` when no results yet, `compact` once results are present. */
  variant: 'hero' | 'compact';
}

function facetMap(facets: FacetCountDTO[]): Record<string, string> {
  return Object.fromEntries(facets.map((f) => [f.id, f.name]));
}

/**
 * Top-level composer island. Owns no filter state — every control reads the URL
 * via `useUpdateSearchParams` and writes through the same hook (or the debounced
 * `useFacetRequery`). Renders the desktop `UnifiedBar` and the mobile
 * `MobileComposerBar`, both bound to the same URL state.
 *
 * `variant`/`hasResults` is the hero-vs-compact split on the SAME `/experts`
 * route: hero (tall, in the gradient block, live-requery disabled) when there are
 * no results yet; compact (short bar, live-requery enabled) once results exist.
 */
export function SearchComposer({
  filters,
  taxonomy,
  facetCounts,
  productNameMap,
  total,
  variant,
}: Readonly<SearchComposerProps>): React.JSX.Element {
  const hasResults = variant === 'compact';
  const nameMaps: ComposerNameMaps = useMemo(
    () => ({
      products: productNameMap,
      supportTypes: facetMap(facetCounts.supportTypes),
      languages: facetMap(facetCounts.languages),
    }),
    [productNameMap, facetCounts.supportTypes, facetCounts.languages]
  );

  const bar = (
    <UnifiedBar
      variant={variant}
      filters={filters}
      taxonomy={taxonomy}
      facetCounts={facetCounts}
      productNameMap={productNameMap}
      nameMaps={nameMaps}
      hasResults={hasResults}
    />
  );

  return (
    <div className="mb-7">
      {/* Desktop bar */}
      <div className="hidden md:block">
        {variant === 'hero' ? (
          <div className="from-primary/5 border-primary/10 rounded-2xl border bg-gradient-to-br to-violet-500/5 p-8 md:p-10">
            <h1 className="text-foreground text-center text-2xl font-semibold md:text-[28px]">
              Find a Salesforce expert
            </h1>
            <p className="text-muted-foreground mx-auto mt-1.5 mb-7 text-center text-[15px]">
              Search by keyword, or narrow with the filters below.
            </p>
            {bar}
          </div>
        ) : (
          bar
        )}
      </div>

      {/* Mobile collapsed bar + one-trigger sheet */}
      <div className="md:hidden">
        {variant === 'hero' && (
          <div className="mb-1">
            <h1 className="text-foreground text-xl font-semibold">Find a Salesforce expert</h1>
            <p className="text-muted-foreground mt-1 mb-4 text-sm">
              Vetted consultants, on a call when you need them.
            </p>
          </div>
        )}
        <MobileComposerBar
          filters={filters}
          taxonomy={taxonomy}
          facetCounts={facetCounts}
          productNameMap={productNameMap}
          total={total}
        />
      </div>
    </div>
  );
}
