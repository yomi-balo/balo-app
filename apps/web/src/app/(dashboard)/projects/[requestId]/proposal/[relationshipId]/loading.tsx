/** Skeleton matching the proposal composer shell (header → tab strip → 2-col). */
export default function ProposalComposerLoading(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-6xl">
      {/* Header */}
      <div className="mb-5 space-y-3">
        <div className="bg-muted h-4 w-40 animate-pulse rounded" />
        <div className="bg-muted h-8 w-64 animate-pulse rounded" />
        <div className="bg-muted h-4 w-80 animate-pulse rounded" />
      </div>

      {/* Tab strip + 2-col body */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="bg-muted/60 h-12 w-full animate-pulse rounded-[12px]" />
          <div className="border-border bg-card space-y-4 rounded-2xl border p-6">
            <div className="bg-muted h-5 w-1/3 animate-pulse rounded" />
            <div className="bg-muted h-28 w-full animate-pulse rounded-[11px]" />
            <div className="bg-muted h-5 w-1/4 animate-pulse rounded" />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="bg-muted h-20 w-full animate-pulse rounded-[12px]" />
              <div className="bg-muted h-20 w-full animate-pulse rounded-[12px]" />
            </div>
          </div>
        </div>
        <div className="border-border bg-card h-72 animate-pulse rounded-2xl border" />
      </div>
    </div>
  );
}
