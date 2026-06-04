import type { Metadata } from 'next';
import Link from 'next/link';
import { log } from '@/lib/logging';
import { parseSearchParams, serializeSearchFilters, DEFAULT_PAGE_SIZE } from '@/lib/search/filters';
import { searchExperts, type FacetCountDTO } from '@/lib/search/search-data';
import { loadSearchTaxonomy } from '@/lib/search/load-taxonomy';
import { buildProductNameMap } from '@/lib/search/taxonomy';
import { mapSearchResultToCardData } from '@/lib/search/expert-card-mapper';
import {
  ActiveFilterChips,
  FacetControls,
  ResultsControls,
  ResultsGrid,
  SearchComposer,
  SearchEmptyState,
  SearchError,
  SearchPagination,
  type FacetLabelMaps,
} from '@/components/search';

export const metadata: Metadata = {
  title: 'Find a Salesforce Expert — Balo',
  description:
    'Search vetted Salesforce consultants on Balo. Filter by skill, support type, language, rate, and availability — then book a call.',
};

type RawSearchParams = Record<string, string | string[] | undefined>;

interface ExpertsPageProps {
  searchParams: Promise<RawSearchParams>;
}

/** Builds an id→name lookup per facet group for chip labels. */
function buildLabelMaps(facetCounts: {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}): FacetLabelMaps {
  const toMap = (facets: FacetCountDTO[]): Record<string, string> =>
    Object.fromEntries(facets.map((f) => [f.id, f.name]));
  return {
    products: toMap(facetCounts.products),
    supportTypes: toMap(facetCounts.supportTypes),
    languages: toMap(facetCounts.languages),
  };
}

export default async function ExpertsPage({
  searchParams,
}: Readonly<ExpertsPageProps>): Promise<React.JSX.Element> {
  const rawParams = await searchParams;
  const filters = parseSearchParams(rawParams);
  // Layout is page-chrome state, not a filter — read it directly from the URL.
  const layout = rawParams.layout === 'list' ? 'list' : 'grid';

  // The browsable taxonomy is independent of the search result — fetch in parallel.
  let response;
  let taxonomy;
  try {
    [response, taxonomy] = await Promise.all([searchExperts(filters), loadSearchTaxonomy()]);
  } catch (error) {
    log.error('Expert search results fetch failed', {
      filters: serializeSearchFilters(filters).toString(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return (
      <div className="bg-background min-h-screen px-4 py-7 sm:px-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-[1320px]">
          <SearchError />
        </div>
      </div>
    );
  }

  const { experts: rawExperts, total, facetCounts, wasAvailabilityGated } = response;
  const experts = rawExperts.map(mapSearchResultToCardData);
  const labelMaps = buildLabelMaps(facetCounts);
  const productNameMap = buildProductNameMap(taxonomy);
  const hasResults = total > 0;

  // Distinguish "no matches at all" from "this page is past the end of the results".
  const isPageBeyondRange = total > 0 && experts.length === 0;

  return (
    <div className="bg-background min-h-screen px-4 py-7 sm:px-6 md:px-8 md:py-8">
      <div className="mx-auto max-w-[1320px]">
        <SearchComposer
          variant={hasResults ? 'compact' : 'hero'}
          filters={filters}
          taxonomy={taxonomy}
          facetCounts={facetCounts}
          productNameMap={productNameMap}
          total={total}
        />

        <div className="flex items-start gap-8">
          {/* Desktop filter rail */}
          <aside className="hidden w-[300px] shrink-0 md:block">
            <div className="bg-card border-border rounded-2xl border p-5 shadow-sm">
              <FacetControls
                mode="committed"
                taxonomy={taxonomy}
                facetCounts={facetCounts}
                productNameMap={productNameMap}
                filters={filters}
                hasResults={hasResults}
                refineSurface="rail"
                productSurface="rail"
              />
            </div>
          </aside>

          {/* Results column */}
          <div className="min-w-0 flex-1">
            <ResultsControls
              shown={experts.length}
              total={total}
              layout={layout}
              sort={filters.sort}
            />
            <ActiveFilterChips filters={filters} labels={labelMaps} />

            {total === 0 && (
              <SearchEmptyState wasAvailabilityGated={wasAvailabilityGated} filters={rawParams} />
            )}

            {isPageBeyondRange && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <h3 className="text-foreground text-lg font-semibold">Nothing on this page</h3>
                <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
                  There are {total} experts matching your filters, but this page is past the end of
                  the results.
                </p>
                <Link
                  href={`/experts?${serializeSearchFilters({ ...filters, page: 1 }).toString()}`}
                  className="border-border text-foreground hover:bg-muted focus-visible:ring-ring mt-4 inline-flex h-10 items-center justify-center rounded-lg border px-5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  Back to page 1
                </Link>
              </div>
            )}

            {experts.length > 0 && (
              <>
                <ResultsGrid
                  experts={experts}
                  layout={layout}
                  sort={filters.sort}
                  page={filters.page}
                />
                <SearchPagination page={filters.page} total={total} pageSize={DEFAULT_PAGE_SIZE} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
