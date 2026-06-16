/** Skeleton matching the portfolio dashboard (lens line → tiles → hero → list). */
export default function ProjectsLoading(): React.JSX.Element {
  return (
    <div>
      {/* Lens line */}
      <div className="mb-4 flex items-center gap-3">
        <div className="bg-muted h-7 w-32 animate-pulse rounded-full" />
        <div className="bg-muted ml-auto h-9 w-48 animate-pulse rounded-lg" />
      </div>

      {/* Header */}
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-40 animate-pulse rounded" />
        <div className="bg-muted h-4 w-64 animate-pulse rounded" />
      </div>

      {/* Stat tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={`tile-${index}`}
            className="border-border bg-card h-[88px] animate-pulse rounded-2xl border"
          />
        ))}
      </div>

      {/* Hero cards */}
      <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <div
            key={`hero-${index}`}
            className="border-border bg-card h-40 animate-pulse rounded-2xl border"
          />
        ))}
      </div>

      {/* List */}
      <div className="border-border bg-card divide-border divide-y rounded-2xl border">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={`row-${index}`} className="flex items-center gap-3 p-4">
            <div className="bg-muted h-2 w-2 shrink-0 animate-pulse rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
              <div className="bg-muted h-3 w-1/3 animate-pulse rounded" />
            </div>
            <div className="bg-muted h-6 w-24 animate-pulse rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
