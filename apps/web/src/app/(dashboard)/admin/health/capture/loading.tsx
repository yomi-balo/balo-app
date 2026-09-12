/**
 * BAL-550 — the route-segment skeleton for `/admin/health/capture`. Tiles + 5 row skeletons
 * (the `admin/lookup/loading.tsx` idiom), a distinct shape from the lookup/catalogue skeletons
 * so the three do not read as a byte-identical jscpd clone.
 */
export default function CaptureHealthLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading capture health…</span>
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-48 animate-pulse rounded" />
        <div className="bg-muted h-4 w-96 max-w-full animate-pulse rounded" />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {['tile-a', 'tile-b', 'tile-c', 'tile-d'].map((key) => (
          <div key={key} className="border-border bg-card rounded-2xl border p-3.5">
            <div className="bg-muted h-3 w-20 animate-pulse rounded" />
            <div className="bg-muted mt-2 h-6 w-10 animate-pulse rounded" />
          </div>
        ))}
      </div>

      <div className="border-border bg-card divide-border divide-y rounded-2xl border">
        {['row-a', 'row-b', 'row-c', 'row-d', 'row-e'].map((key) => (
          <div key={key} className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[1.15fr_2fr_auto]">
            <div className="space-y-2">
              <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
              <div className="bg-muted h-3 w-1/2 animate-pulse rounded" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-muted h-6 animate-pulse rounded-full" />
              <div className="bg-muted h-6 animate-pulse rounded-full" />
              <div className="bg-muted h-6 animate-pulse rounded-full" />
            </div>
            <div className="bg-muted h-8 w-24 animate-pulse rounded" />
          </div>
        ))}
      </div>
    </output>
  );
}
