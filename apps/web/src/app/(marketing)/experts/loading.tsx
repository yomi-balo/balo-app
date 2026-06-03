import { ResultsGridSkeleton } from '@/components/search';

/**
 * Route-level loading UI shown during the RSC search fetch. Renders the page-frame
 * shell with a skeleton grid that matches the card shape (no spinners).
 */
export default function ExpertsLoading(): React.JSX.Element {
  return (
    <div className="bg-background min-h-screen px-4 py-7 sm:px-6 md:px-8 md:py-8">
      <div className="mx-auto max-w-[1320px]">
        {/* Hero shell */}
        <div className="from-primary/5 border-primary/10 mb-7 rounded-2xl border bg-gradient-to-br to-violet-500/5 p-6 md:p-7">
          <div className="bg-muted h-7 w-64 max-w-full animate-pulse rounded" />
          <div className="bg-muted mt-3 h-4 w-96 max-w-full animate-pulse rounded" />
          <div className="bg-muted mt-4 h-[52px] w-full animate-pulse rounded-xl" />
        </div>

        <div className="flex items-start gap-8">
          {/* Rail shell */}
          <aside className="hidden w-[252px] shrink-0 space-y-4 md:block">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <div className="bg-muted h-3 w-24 animate-pulse rounded" />
                <div className="bg-muted h-5 w-full animate-pulse rounded" />
                <div className="bg-muted h-5 w-5/6 animate-pulse rounded" />
              </div>
            ))}
          </aside>

          {/* Results shell */}
          <div className="min-w-0 flex-1">
            <div className="bg-muted mb-5 h-7 w-48 animate-pulse rounded" />
            <ResultsGridSkeleton count={6} />
          </div>
        </div>
      </div>
    </div>
  );
}
