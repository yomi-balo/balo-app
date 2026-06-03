import { ExpertCardSkeleton } from '@/components/expert';

interface ResultsGridSkeletonProps {
  /** Number of skeleton cards to render. */
  count?: number;
}

const GRID_STYLE = {
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
} as const;

/**
 * Grid of `ExpertCardSkeleton` shown during the RSC data fetch (route `loading.tsx`
 * and pending-navigation states). Skeletons match the card shape — no spinners.
 */
export function ResultsGridSkeleton({
  count = 6,
}: Readonly<ResultsGridSkeletonProps>): React.JSX.Element {
  return (
    <div className="grid items-stretch gap-4 md:gap-5" style={GRID_STYLE}>
      {Array.from({ length: count }).map((_, i) => (
        <ExpertCardSkeleton key={i} variant="grid" />
      ))}
    </div>
  );
}
