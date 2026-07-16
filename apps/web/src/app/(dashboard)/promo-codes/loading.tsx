/** Skeleton matching the promo-code list (header → 5 tiles → section label → rows). */
export default function PromoCodesLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading promo codes…</span>
      {/* Header */}
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-40 animate-pulse rounded" />
        <div className="bg-muted h-4 w-80 max-w-full animate-pulse rounded" />
      </div>

      {/* Stat tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {['tile-a', 'tile-b', 'tile-c', 'tile-d', 'tile-e'].map((key) => (
          <div
            key={key}
            className="border-border bg-card h-[88px] animate-pulse rounded-2xl border"
          />
        ))}
      </div>

      {/* Section label */}
      <div className="bg-muted mb-3 h-4 w-32 animate-pulse rounded" />

      {/* List */}
      <div className="border-border bg-card divide-border divide-y rounded-2xl border">
        {['row-a', 'row-b', 'row-c', 'row-d'].map((key) => (
          <div key={key} className="flex items-start gap-3 p-4">
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
              <div className="bg-muted h-3 w-1/2 animate-pulse rounded" />
              <div className="bg-muted h-3 w-2/5 animate-pulse rounded" />
            </div>
            <div className="bg-muted h-6 w-20 shrink-0 animate-pulse rounded-full" />
          </div>
        ))}
      </div>
    </output>
  );
}
