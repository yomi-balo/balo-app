/** The Account page's loading shell — the name card's shape, so nothing shifts when it lands. */
export default function Loading(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div
        className="border-border bg-card rounded-2xl border p-6 shadow-sm"
        data-testid="account-name-skeleton"
      >
        <div className="bg-muted mb-3 h-4 w-24 animate-pulse rounded" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="bg-muted/60 h-9 w-full animate-pulse rounded-lg" />
          <div className="bg-muted/60 h-9 w-full animate-pulse rounded-lg" />
        </div>
        <div className="mt-4 flex justify-end">
          <div className="bg-muted h-9 w-28 animate-pulse rounded-lg" />
        </div>
      </div>
    </div>
  );
}
