export type ResultsLayout = 'grid' | 'list';

/** Desktop default for `/experts`. Mobile always renders the grid regardless. */
export const DEFAULT_RESULTS_LAYOUT: ResultsLayout = 'list';

/** Reads the `layout` URL param; anything other than exactly `grid` or `list` is the default. */
export function parseResultsLayout(raw: string | string[] | undefined): ResultsLayout {
  if (raw === 'grid' || raw === 'list') return raw;
  return DEFAULT_RESULTS_LAYOUT;
}

/** The `layout` param value to write for `next`, or `null` (clear the param) when it is the default. */
export function layoutParamFor(next: ResultsLayout): string | null {
  return next === DEFAULT_RESULTS_LAYOUT ? null : next;
}
