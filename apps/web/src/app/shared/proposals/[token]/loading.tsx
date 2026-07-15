/** Skeleton for the public shared-proposal segment (BAL-386) while it resolves. */
export default function SharedProposalLoading(): React.JSX.Element {
  return (
    <div className="border-border bg-card overflow-hidden rounded-2xl border" aria-hidden="true">
      <div className="h-14 bg-gradient-to-br from-slate-900 to-slate-800" />
      <div className="space-y-4 p-6">
        <div className="bg-muted h-6 w-2/3 animate-pulse rounded" />
        <div className="bg-muted h-4 w-1/3 animate-pulse rounded" />
        <div className="bg-muted h-20 w-full animate-pulse rounded-2xl" />
        <div className="bg-muted h-4 w-full animate-pulse rounded" />
        <div className="bg-muted h-4 w-5/6 animate-pulse rounded" />
        <div className="bg-muted h-16 w-full animate-pulse rounded-xl" />
        <div className="bg-muted h-16 w-full animate-pulse rounded-xl" />
      </div>
    </div>
  );
}
