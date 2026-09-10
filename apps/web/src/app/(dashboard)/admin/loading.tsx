/** BAL-548 — skeleton matching the Home queue: header shimmer, a 4-up tile grid, a section
 *  label, then a card of four row skeletons. Copies `catalogue/loading.tsx`'s structure. */
export default function AdminHomeLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading the pending-actions queue…</span>

      {/* Header */}
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-56 animate-pulse rounded" />
        <div className="bg-muted h-4 w-96 max-w-full animate-pulse rounded" />
      </div>

      {/* Tiles */}
      <div className="mb-6 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {['tile-a', 'tile-b', 'tile-c', 'tile-d'].map((key) => (
          <div key={key} className="bg-muted h-[82px] animate-pulse rounded-2xl" />
        ))}
      </div>

      {/* Section label */}
      <div className="bg-muted mb-2 h-4 w-32 animate-pulse rounded" />

      {/* List */}
      <div className="border-border bg-card divide-border divide-y rounded-2xl border">
        {['row-a', 'row-b', 'row-c', 'row-d'].map((key) => (
          <div key={key} className="flex items-start gap-3 p-4">
            <div className="bg-muted size-[30px] shrink-0 animate-pulse rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-4 w-1/3 animate-pulse rounded" />
              <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
              <div className="bg-muted h-3 w-1/2 animate-pulse rounded" />
            </div>
            <div className="bg-muted h-5 w-10 shrink-0 animate-pulse rounded-full" />
          </div>
        ))}
      </div>
    </output>
  );
}
