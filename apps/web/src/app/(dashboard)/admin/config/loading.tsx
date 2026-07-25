/** Skeleton matching the platform-config surface (header → one config card with a field). */
export default function PlatformConfigLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading platform config…</span>
      {/* Header */}
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-48 animate-pulse rounded" />
        <div className="bg-muted h-4 w-80 max-w-full animate-pulse rounded" />
      </div>

      {/* Config card */}
      <div className="border-border bg-card max-w-xl space-y-4 rounded-2xl border p-6">
        <div className="bg-muted h-5 w-40 animate-pulse rounded" />
        <div className="space-y-2">
          <div className="bg-muted h-4 w-56 animate-pulse rounded" />
          <div className="bg-muted h-10 w-40 animate-pulse rounded" />
          <div className="bg-muted h-3 w-72 max-w-full animate-pulse rounded" />
        </div>
        <div className="bg-muted h-9 w-28 animate-pulse rounded" />
      </div>
    </output>
  );
}
