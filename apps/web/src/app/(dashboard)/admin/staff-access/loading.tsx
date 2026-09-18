/**
 * BAL-561 — skeleton for the Staff access two-column split (roster left, detail right).
 * Deliberately a DIFFERENT shape from `admin/applications/loading.tsx` (a single list with
 * chips) — same `<output aria-busy>` idiom, different structure and copy, so jscpd sees no
 * near-duplicate.
 */
export default function StaffAccessLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading staff access…</span>
      {/* Page header */}
      <div className="mb-6 space-y-2">
        <div className="bg-muted h-7 w-36 animate-pulse rounded" />
        <div className="bg-muted h-4 w-[28rem] max-w-full animate-pulse rounded" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* Roster */}
        <div className="border-border bg-card space-y-3 rounded-2xl border p-4">
          <div className="bg-muted h-9 w-full animate-pulse rounded-lg" />
          {['roster-a', 'roster-b', 'roster-c', 'roster-d', 'roster-e'].map((key) => (
            <div key={key} className="flex items-center gap-3">
              <div className="bg-muted size-8 shrink-0 animate-pulse rounded-full" />
              <div className="flex-1 space-y-1.5">
                <div className="bg-muted h-3.5 w-2/3 animate-pulse rounded" />
                <div className="bg-muted h-3 w-1/3 animate-pulse rounded" />
              </div>
            </div>
          ))}
        </div>

        {/* Detail */}
        <div className="border-border bg-card space-y-4 rounded-2xl border p-4">
          <div className="bg-muted h-[52px] w-full animate-pulse rounded-xl" />
          {[
            'detail-1',
            'detail-2',
            'detail-3',
            'detail-4',
            'detail-5',
            'detail-6',
            'detail-7',
            'detail-8',
          ].map((key) => (
            <div key={key} className="bg-muted h-8 w-full animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    </output>
  );
}
