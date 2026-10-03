import { EMPTY_FILTERS, serializeSearchFilters } from './filters';

/**
 * The expert-search link behind a paused expert's "Find a similar expert": the same vertical and
 * (when known) the expert's top product, narrowed to experts with an opening this week, sorted
 * soonest first. The `week` timeframe is what keeps paused experts out of the results: their
 * availability cache is empty, so they never match it.
 */
export function buildSimilarExpertsHref({
  verticalSlug,
  productId,
}: Readonly<{ verticalSlug: string; productId?: string }>): string {
  const params = serializeSearchFilters({
    ...EMPTY_FILTERS,
    vertical: verticalSlug,
    products: productId === undefined ? [] : [productId],
    timeframe: 'week',
    sort: 'soonest',
  });
  return `/experts?${params.toString()}`;
}
