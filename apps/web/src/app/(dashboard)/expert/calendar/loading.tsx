/**
 * BAL-498 — the Calendar route's LOADING state. Hand-rolled to mirror the real layout (header
 * row, switcher pill rail, then grid chrome with a few block placeholders per column) so the
 * page does not visibly re-flow when data lands. Precedent: `expert/settings/loading.tsx`,
 * `cases/[engagementId]/loading.tsx`.
 */
const DAY_COLUMN_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
const BLOCK_KEYS = ['a', 'b'] as const;

export default function ExpertCalendarLoading(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <output aria-label="Loading calendar" className="block">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <span className="bg-muted mb-2 block h-7 w-32 animate-pulse rounded" />
            <span className="bg-muted/60 block h-4 w-40 animate-pulse rounded" />
          </div>
          <span className="bg-muted block h-9 w-36 animate-pulse rounded-md" />
        </div>

        {/* Switcher pill rail */}
        <div className="bg-muted mb-4 inline-flex h-10 w-40 animate-pulse rounded-xl" />

        {/* Grid chrome */}
        <div className="border-border bg-card grid grid-cols-[56px_repeat(5,1fr)] gap-px overflow-hidden rounded-xl border">
          <span className="bg-card h-10" />
          {DAY_COLUMN_KEYS.map((key) => (
            <span key={key} className="bg-card flex h-10 items-center justify-center">
              <span className="bg-muted h-3 w-10 animate-pulse rounded" />
            </span>
          ))}
          <span className="bg-card row-span-2 h-64" />
          {DAY_COLUMN_KEYS.map((columnKey) => (
            <span key={columnKey} className="bg-card relative h-64 p-2">
              {BLOCK_KEYS.map((blockKey) => (
                <span
                  key={blockKey}
                  className="bg-muted mb-2 block h-14 w-full animate-pulse rounded-md"
                />
              ))}
            </span>
          ))}
        </div>
        <span className="sr-only">Loading…</span>
      </output>
    </div>
  );
}
