/** Skeleton for the redeem panel (icon + heading → input → button). */
export default function RedeemLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="mx-auto block w-full max-w-lg py-6">
      <span className="sr-only">Loading…</span>
      <div className="border-border bg-card rounded-2xl border p-6">
        <div className="mb-5 flex items-start gap-3">
          <div className="bg-muted h-10 w-10 shrink-0 animate-pulse rounded-xl" />
          <div className="flex-1 space-y-2">
            <div className="bg-muted h-5 w-48 animate-pulse rounded" />
            <div className="bg-muted h-4 w-64 max-w-full animate-pulse rounded" />
          </div>
        </div>
        <div className="space-y-4">
          <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
          <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        </div>
      </div>
    </output>
  );
}
