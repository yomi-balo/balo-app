/** BAL-549 — skeleton matching the review page (header → banner → four section blocks). */
export default function AdminApplicationReviewLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="mx-auto block max-w-3xl">
      <span className="sr-only">Loading the application…</span>
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-56 animate-pulse rounded" />
        <div className="bg-muted h-4 w-72 max-w-full animate-pulse rounded" />
      </div>
      <div className="flex flex-col gap-4">
        {['block-a', 'block-b', 'block-c', 'block-d'].map((key) => (
          <div key={key} className="border-border bg-card rounded-2xl border p-5">
            <div className="bg-muted mb-3 h-4 w-32 animate-pulse rounded" />
            <div className="bg-muted h-10 w-full animate-pulse rounded" />
          </div>
        ))}
      </div>
    </output>
  );
}
