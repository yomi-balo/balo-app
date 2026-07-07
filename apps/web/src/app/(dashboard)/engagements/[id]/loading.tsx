/** Skeleton matching the delivery workspace (header → banner → progress → rail). */
export default function EngagementWorkspaceLoading(): React.JSX.Element {
  return (
    <div className="space-y-5">
      {/* Header: back-link + title + status chip, sub-line, terms strip */}
      <div className="space-y-3">
        <div className="bg-muted h-4 w-24 animate-pulse rounded-full" />
        <div className="flex items-center gap-3">
          <div className="bg-muted h-8 w-2/3 animate-pulse rounded" />
          <div className="bg-muted ml-auto h-7 w-32 animate-pulse rounded-full" />
        </div>
        <div className="bg-muted h-4 w-1/2 animate-pulse rounded" />
        <div className="flex flex-wrap gap-2">
          <div className="bg-muted h-7 w-40 animate-pulse rounded-full" />
          <div className="bg-muted h-7 w-32 animate-pulse rounded-full" />
          <div className="bg-muted h-7 w-36 animate-pulse rounded-full" />
        </div>
      </div>

      {/* State banner */}
      <div className="border-border bg-card h-24 animate-pulse rounded-2xl border" />

      {/* Progress card */}
      <div className="border-border bg-card space-y-3 rounded-2xl border p-6">
        <div className="flex items-center justify-between">
          <div className="bg-muted h-5 w-48 animate-pulse rounded" />
          <div className="bg-muted h-5 w-12 animate-pulse rounded" />
        </div>
        <div className="bg-muted h-2 w-full animate-pulse rounded-full" />
      </div>

      {/* Milestone rail */}
      <div className="border-border bg-card space-y-4 rounded-2xl border p-6">
        <div className="bg-muted h-4 w-32 animate-pulse rounded" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-4">
            <div className="bg-muted h-6 w-6 shrink-0 animate-pulse rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-5 w-1/2 animate-pulse rounded" />
              <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
