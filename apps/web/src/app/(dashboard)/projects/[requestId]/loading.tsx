/** Skeleton matching the request-detail shell (lens line → nudge → hero/grid). */
export default function RequestDetailLoading(): React.JSX.Element {
  return (
    <div>
      {/* Lens line */}
      <div className="mb-4 flex items-center gap-3">
        <div className="bg-muted h-7 w-36 animate-pulse rounded-full" />
        <div className="bg-muted ml-auto h-5 w-32 animate-pulse rounded-full" />
      </div>

      {/* Nudge bar */}
      <div className="border-border bg-card mb-5 h-24 animate-pulse rounded-2xl border" />

      {/* Main content */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="border-border bg-card space-y-4 rounded-2xl border p-6">
          <div className="bg-muted h-6 w-2/3 animate-pulse rounded" />
          <div className="bg-muted h-4 w-1/3 animate-pulse rounded" />
          <div className="space-y-2 pt-2">
            <div className="bg-muted h-4 w-full animate-pulse rounded" />
            <div className="bg-muted h-4 w-full animate-pulse rounded" />
            <div className="bg-muted h-4 w-4/5 animate-pulse rounded" />
          </div>
        </div>
        <div className="border-border bg-card h-64 animate-pulse rounded-2xl border" />
      </div>
    </div>
  );
}
