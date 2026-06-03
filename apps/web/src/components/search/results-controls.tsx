'use client';

import type { SortValue } from '@/lib/search/filters';
import { ResultsToolbar } from './results-toolbar';

interface ResultsControlsProps {
  shown: number;
  total: number;
  layout: 'grid' | 'list';
  sort: SortValue;
}

/**
 * Client island wrapping the results toolbar (count + trust line, desktop
 * grid/list toggle + sort, mobile sort). The mobile filter trigger lives in the
 * one-tap `MobileComposerBar` (BAL-249) — this no longer owns a filter sheet.
 */
export function ResultsControls({
  shown,
  total,
  layout,
  sort,
}: Readonly<ResultsControlsProps>): React.JSX.Element {
  return <ResultsToolbar shown={shown} total={total} layout={layout} sort={sort} />;
}
