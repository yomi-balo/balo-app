/**
 * BAL-551 — the route-segment skeleton for `/admin/lookup`. `admin/` has no shared
 * `loading.tsx`, and unlike `/admin/catalogue` (zero I/O) this page does a real read, so it
 * needs its own. Deliberately a DIFFERENT shape from `catalogue/loading.tsx` (search box +
 * chip row + two-column result grid, rather than a single list) so the two do not read as a
 * byte-identical jscpd clone (memory `reference_sonar_duplication_not_caught_locally`).
 */
export default function AdminLookupLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading Lookup…</span>
      {/* Heading */}
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-40 animate-pulse rounded" />
        <div className="bg-muted h-4 w-80 max-w-full animate-pulse rounded" />
      </div>

      {/* Search box */}
      <div className="bg-muted mb-4 h-11 w-full animate-pulse rounded-xl" />

      {/* Chip row */}
      <div className="mb-4 flex gap-1.5">
        {['chip-a', 'chip-b', 'chip-c', 'chip-d', 'chip-e'].map((key) => (
          <div key={key} className="bg-muted h-8 w-20 shrink-0 animate-pulse rounded-full" />
        ))}
      </div>

      {/* Two-column result grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="border-border bg-card divide-border divide-y rounded-2xl border">
          {['row-a', 'row-b', 'row-c'].map((key) => (
            <div key={key} className="flex items-center gap-3 p-4">
              <div className="bg-muted size-[30px] shrink-0 animate-pulse rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="bg-muted h-4 w-1/3 animate-pulse rounded" />
                <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
              </div>
            </div>
          ))}
        </div>
        <div className="border-border bg-card hidden rounded-2xl border p-4 lg:block">
          <div className="bg-muted h-4 w-24 animate-pulse rounded" />
          <div className="bg-muted mt-3 h-5 w-48 animate-pulse rounded" />
        </div>
      </div>
    </output>
  );
}
