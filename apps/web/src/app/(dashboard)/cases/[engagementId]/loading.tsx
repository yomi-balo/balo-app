/**
 * BAL-421 — the case surface's route-level LOADING state. Hand-rolled to mirror the real
 * section order (header → main column → rail) so the page does not visibly re-flow when the
 * data lands. Precedent: the recap's and the engagement workspace's `loading.tsx` are
 * hand-rolled for the same reason rather than reaching for a generic skeleton.
 *
 * ⚠ THE CONTAINER MUST STAY IN SYNC WITH `page.tsx`, `error.tsx` AND `not-found.tsx`
 * (`max-w-[1060px]` + the same padding scale). Three of the four differ only in vertical
 * padding; if they drift, the route visibly jumps between states.
 */
export default function CaseLoading(): React.JSX.Element {
  return (
    <div className="from-background to-muted/30 min-h-full bg-gradient-to-b">
      <output
        aria-label="Loading case"
        className="mx-auto block w-full max-w-[1060px] px-4 py-8 sm:px-6 lg:px-8"
      >
        {/* header */}
        <span className="bg-card border-border mb-3 block rounded-3xl border px-6 py-5">
          <span className="bg-muted mb-3 block h-6 w-2/3 animate-pulse rounded" />
          <span className="bg-muted/60 mb-4 block h-3 w-1/2 animate-pulse rounded" />
          <span className="bg-muted/60 block h-3 w-full animate-pulse rounded" />
        </span>

        <span className="flex flex-wrap items-start gap-3">
          <span className="flex min-w-0 flex-col gap-3" style={{ flex: '1 1 420px' }}>
            <SkeletonCard lines={4} />
            <SkeletonCard lines={3} />
          </span>
          <span className="flex flex-col gap-3" style={{ flex: '0 1 288px', minWidth: 264 }}>
            {/* FOUR, matching the rail's party + action items + files + people. A shorter
                skeleton re-flows on exactly the cell this file exists to stabilise. */}
            <SkeletonCard lines={3} />
            <SkeletonCard lines={2} />
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
    <span className="bg-card border-border block rounded-3xl border px-5 py-4">
      <span className="bg-muted mb-4 block h-3 w-28 animate-pulse rounded" />
      {LINE_KEYS.slice(0, lines).map((key) => (
        <span key={key} className="bg-muted/60 mb-2.5 block h-3 w-full animate-pulse rounded" />
      ))}
    </span>
  );
}
