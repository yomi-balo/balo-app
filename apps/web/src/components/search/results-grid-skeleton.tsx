import { ExpertCardSkeleton } from '@/components/expert';
import type { ResultsLayout } from '@/lib/search/layout';

interface ResultsGridSkeletonProps {
  /** Number of skeleton cards to render. */
  count?: number;
  /** Which layout's skeleton to show; `'list'` mirrors `ResultsBlocks` (mobile grid, desktop list). */
  layout: ResultsLayout;
}

const GRID_STYLE = {
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
} as const;

function GridSkeletons({ count }: Readonly<{ count: number }>): React.JSX.Element {
  return (
    <div className="grid items-stretch gap-4 md:gap-5" style={GRID_STYLE}>
      {Array.from({ length: count }).map((_, i) => (
        <ExpertCardSkeleton key={i} variant="grid" />
      ))}
    </div>
  );
}

/**
 * Skeletons shown during the RSC data fetch (route `loading.tsx` and pending-navigation
 * states). They match the card shape — no spinners. `'list'` follows `ResultsBlocks`: the
 * grid below `md`, list rows at/above it.
 */
export function ResultsGridSkeleton({
  count = 6,
  layout,
}: Readonly<ResultsGridSkeletonProps>): React.JSX.Element {
  if (layout === 'grid') {
    return <GridSkeletons count={count} />;
  }

  return (
    <>
      <div className="md:hidden">
        <GridSkeletons count={count} />
      </div>
      <div className="hidden md:block">
        <div className="grid grid-cols-1 gap-4">
          {Array.from({ length: count }).map((_, i) => (
            <ExpertCardSkeleton key={i} variant="list" />
          ))}
        </div>
      </div>
    </>
  );
}
