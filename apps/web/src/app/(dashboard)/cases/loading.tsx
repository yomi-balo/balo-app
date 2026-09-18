/**
 * BAL-567 — the `/cases` route segment's LOADING state.
 *
 * ⚠ IT MIRRORS THE REAL SECTION ORDER (heading + CTA → section head → ticket → grid), so the page
 * does not visibly re-flow when the data lands — the same reason the case surface's and the
 * recap's `loading.tsx` are hand-rolled rather than reaching for a generic skeleton.
 *
 * ⚠ AN `<output>` WITH A LABEL, NOT A BARE `<div>`. `<output>` maps to role `status`, so a screen
 * reader announces that something is loading instead of reading out a page of empty boxes. Same
 * posture as `cases/[engagementId]/loading.tsx`.
 *
 * ⚠ IT DOES NOT APPLY TO `/cases/[engagementId]` — that segment has its own `loading.tsx`, which
 * takes precedence for its own subtree.
 */

/** Stable keys for the placeholder cards — never an array index (SonarCloud S6479). */
const GRID_PLACEHOLDERS = ['card-a', 'card-b', 'card-c', 'card-d'];

export default function CasesLoading(): React.JSX.Element {
  return (
    <output aria-label="Loading cases" className="block">
      <span className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <span className="block space-y-2">
          <span className="bg-muted block h-8 w-32 animate-pulse rounded" />
          <span className="bg-muted block h-4 w-64 animate-pulse rounded" />
        </span>
        <span className="bg-muted block h-10 w-full animate-pulse rounded-lg sm:w-44" />
      </span>

      <span className="bg-muted mb-3 block h-4 w-20 animate-pulse rounded" />
      <span className="border-border bg-card block h-52 animate-pulse rounded-2xl border" />

      <span className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {GRID_PLACEHOLDERS.map((key) => (
          <span key={key} className="border-border bg-card h-56 animate-pulse rounded-2xl border" />
        ))}
      </span>
    </output>
  );
}
