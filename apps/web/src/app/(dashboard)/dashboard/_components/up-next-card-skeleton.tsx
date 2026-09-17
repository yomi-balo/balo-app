/**
 * BAL-566 — the Up next card's Suspense fallback. No hooks, no client boundary — a plain
 * presentational skeleton that mirrors the real card's outer shell so nothing jumps on hydration.
 */
export function UpNextCardSkeleton(): React.JSX.Element {
  return (
    <section
      aria-busy="true"
      className="bg-card border-border rounded-2xl border px-[18px] pt-[18px] pb-1.5 shadow-sm"
    >
      <div className="bg-muted h-[17px] w-24 animate-pulse rounded" />
      <div className="bg-muted mt-2 mb-3 h-[13px] w-56 animate-pulse rounded" />
      <div className="space-y-3">
        {['a', 'b', 'c'].map((key) => (
          <div key={key} className="flex items-center gap-3 py-1">
            <div className="bg-muted size-9 shrink-0 animate-pulse rounded-[10px]" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="bg-muted h-3 w-28 animate-pulse rounded" />
              <div className="bg-muted h-3.5 w-40 animate-pulse rounded" />
            </div>
            <div className="shrink-0 space-y-1.5 text-right">
              <div className="bg-muted ml-auto h-3.5 w-16 animate-pulse rounded" />
              <div className="bg-muted ml-auto h-3 w-10 animate-pulse rounded" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
