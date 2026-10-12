/** Skeleton matching the staff domains page: back link, party header, domains card, add card. */
export default function AdminPartyDomainsLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="mx-auto block max-w-3xl">
      <span className="sr-only">Loading the domains…</span>
      <div className="bg-muted mb-4 h-4 w-28 animate-pulse rounded" />
      <div className="mb-6 flex items-center gap-3.5">
        <div className="bg-muted size-11 animate-pulse rounded-xl" />
        <div className="space-y-2">
          <div className="bg-muted h-6 w-56 animate-pulse rounded" />
          <div className="bg-muted h-4 w-32 animate-pulse rounded" />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {['block-list', 'block-add'].map((key) => (
          <div key={key} className="border-border bg-card rounded-2xl border p-5">
            <div className="bg-muted mb-3 h-4 w-32 animate-pulse rounded" />
            <div className="bg-muted h-10 w-full animate-pulse rounded" />
          </div>
        ))}
      </div>
    </output>
  );
}
