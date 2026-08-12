/**
 * BAL-388 — the recap's route-level LOADING state. Hand-rolled to mirror the real section
 * order (header → main column → rail), so the page does not visibly re-flow when the data
 * lands. Precedent: `engagements/[id]/loading.tsx` is hand-rolled for the same reason rather
 * than reaching for a generic skeleton.
 */
export default function RecapLoading(): React.JSX.Element {
  return (
    <div className="from-background to-muted/30 min-h-full bg-gradient-to-b">
      <output
        aria-label="Loading recap"
        className="mx-auto block w-full max-w-[1060px] px-4 py-8 sm:px-6 lg:px-8"
      >
        <span className="bg-muted mb-3 block h-3 w-24 animate-pulse rounded" />
        <span className="bg-muted mb-4 block h-6 w-2/3 animate-pulse rounded" />
        <span className="bg-muted/60 mb-6 block h-3 w-1/2 animate-pulse rounded" />

        <span className="grid items-start gap-4 lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] lg:gap-6">
          <span className="flex flex-col gap-4 lg:gap-6">
            <SkeletonCard lines={3} />
            <SkeletonCard lines={4} />
            <SkeletonCard lines={3} />
          </span>
          <span className="flex flex-col gap-4 lg:gap-6">
            {/* THREE, not two: the client lens renders party + wrap-up + files on the rail, and
                a two-card skeleton re-flows on exactly the cell this file exists to stabilise. */}
            <SkeletonCard lines={3} />
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
          </span>
        </span>
        <span className="sr-only">Loading…</span>
      </output>
    </div>
  );
}

/** ⚠ Keys come from a FIXED literal array — never an array index (SonarCloud S6479). */
const LINE_KEYS = ['a', 'b', 'c', 'd'] as const;

function SkeletonCard({ lines }: Readonly<{ lines: number }>): React.JSX.Element {
  return (
    <span className="bg-card border-border block rounded-2xl border p-6">
      <span className="bg-muted mb-4 block h-3 w-28 animate-pulse rounded" />
      {LINE_KEYS.slice(0, lines).map((key) => (
        <span key={key} className="bg-muted/60 mb-2.5 block h-3 w-full animate-pulse rounded" />
      ))}
    </span>
  );
}
