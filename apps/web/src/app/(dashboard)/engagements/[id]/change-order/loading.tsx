/** Skeleton matching the composer: header, then the two-column note + milestones | summary layout. */
export default function ChangeOrderComposerLoading(): React.JSX.Element {
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="bg-muted h-4 w-28 animate-pulse rounded-full" />
        <div className="bg-muted h-8 w-64 animate-pulse rounded" />
        <div className="bg-muted h-4 w-1/2 animate-pulse rounded" />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <div className="border-border bg-card space-y-3 rounded-2xl border p-5">
            <div className="bg-muted h-4 w-44 animate-pulse rounded" />
            <div className="bg-muted h-20 w-full animate-pulse rounded-lg" />
          </div>
          <div className="border-border bg-card space-y-3 rounded-2xl border p-5">
            <div className="bg-muted h-4 w-28 animate-pulse rounded" />
            {[0, 1, 2].map((i) => (
              <div key={i} className="border-border space-y-2 rounded-xl border p-4">
                <div className="bg-muted h-5 w-24 animate-pulse rounded-full" />
                <div className="bg-muted h-9 w-full animate-pulse rounded-lg" />
                <div className="bg-muted h-14 w-full animate-pulse rounded-lg" />
              </div>
            ))}
          </div>
        </div>

        <div className="border-border bg-card space-y-3 rounded-2xl border p-5">
          <div className="bg-muted h-4 w-24 animate-pulse rounded" />
          <div className="bg-muted h-4 w-20 animate-pulse rounded" />
          <div className="bg-muted h-9 w-full animate-pulse rounded-lg" />
          <div className="bg-muted h-10 w-full animate-pulse rounded-lg" />
        </div>
      </div>
    </div>
  );
}
