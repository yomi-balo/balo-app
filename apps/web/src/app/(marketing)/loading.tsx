/**
 * Route-level loading UI shown while `loadHomeData()`'s `Promise.all` (search + taxonomy +
 * spotlight) resolves. Mirrors `experts/loading.tsx`'s house style — a shell that echoes the
 * real layout's shape (hero + bench row) with `animate-pulse` blocks, no spinners.
 */
export default function MarketingHomeLoading(): React.JSX.Element {
  return (
    <div className="bg-background min-h-screen px-4 py-7 sm:px-6 md:px-8 md:py-8">
      <div className="mx-auto max-w-[1320px]">
        {/* Hero shell */}
        <div className="from-primary/5 border-primary/10 mb-7 rounded-2xl border bg-gradient-to-br to-violet-500/5 p-6 md:p-7">
          <div className="bg-muted h-4 w-40 max-w-full animate-pulse rounded-full" />
          <div className="bg-muted mt-4 h-10 w-2/3 max-w-full animate-pulse rounded" />
          <div className="bg-muted mt-2 h-10 w-1/2 max-w-full animate-pulse rounded" />
          <div className="bg-muted mt-4 h-4 w-96 max-w-full animate-pulse rounded" />
          <div className="bg-muted mt-6 h-[52px] w-full animate-pulse rounded-xl" />
        </div>

        {/* Bench row shell */}
        <div className="mb-7 flex gap-3 overflow-hidden">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="bg-muted h-16 w-56 shrink-0 animate-pulse rounded-xl" />
          ))}
        </div>

        {/* Proof band shell */}
        <div className="mb-7 grid grid-cols-2 gap-4 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-2">
              <div className="bg-muted h-7 w-20 animate-pulse rounded" />
              <div className="bg-muted h-3 w-24 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
