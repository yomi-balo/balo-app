/** BAL-549 — skeleton matching the applications list (header → chips → four pulsing rows). */
export default function AdminApplicationsLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading applications…</span>
      {/* Header */}
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-40 animate-pulse rounded" />
        <div className="bg-muted h-4 w-96 max-w-full animate-pulse rounded" />
      </div>

      {/* Chips */}
      <div className="mb-4 flex gap-1.5">
        {['chip-a', 'chip-b', 'chip-c'].map((key) => (
          <div key={key} className="bg-muted h-8 w-24 animate-pulse rounded-full" />
        ))}
      </div>

      {/* List */}
      <div className="border-border bg-card divide-border divide-y rounded-2xl border">
        {['row-a', 'row-b', 'row-c', 'row-d'].map((key) => (
          <div key={key} className="flex items-center gap-3 p-4">
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-4 w-1/3 animate-pulse rounded" />
              <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
            </div>
            <div className="bg-muted h-4 w-16 shrink-0 animate-pulse rounded" />
          </div>
        ))}
      </div>
    </output>
  );
}
