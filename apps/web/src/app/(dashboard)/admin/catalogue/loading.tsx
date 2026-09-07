/** BAL-534 — skeleton matching the catalogue list (header → six pulsing rows). */
export default function AdminCatalogueLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading the catalogue…</span>
      {/* Header */}
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-56 animate-pulse rounded" />
        <div className="bg-muted h-4 w-96 max-w-full animate-pulse rounded" />
      </div>

      {/* List */}
      <div className="border-border bg-card divide-border divide-y rounded-2xl border">
        {['row-a', 'row-b', 'row-c', 'row-d', 'row-e', 'row-f'].map((key) => (
          <div key={key} className="flex items-center gap-3 p-4">
            <div className="bg-muted size-[30px] shrink-0 animate-pulse rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-4 w-1/3 animate-pulse rounded" />
              <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
            </div>
            <div className="bg-muted h-5 w-16 shrink-0 animate-pulse rounded-full" />
          </div>
        ))}
      </div>
    </output>
  );
}
