/**
 * BAL-439 §12 — the guest recap's skeleton, drawn in the PAGE'S OWN SHAPE (label chip, title
 * bar, two meta rows, then a summary block and a files block) rather than a spinner, so the
 * layout does not jump when the real content lands. Same posture as the shipped `/join/[token]`
 * and `/review/[token]` skeletons.
 *
 * ⚠ IT ANNOUNCES ITSELF. `<output>` carries an implicit polite live region (and NOT
 * `role="status"`, which SonarCloud flags under S6819); the `sr-only` line is what it announces.
 *
 * ⚠⚠ `aria-busy` SITS ON THE **DECORATIVE WRAPPER**, NEVER ON THE `<output>`. `aria-busy`
 * SUPPRESSES a live region's own announcements — on the `<output>` it would silence the very
 * "Loading the recap…" line this element exists to announce.
 */
export default function GuestRecapLoading(): React.JSX.Element {
  return (
    <output className="mx-auto block w-full max-w-md space-y-5">
      <span className="sr-only">Loading the recap…</span>

      <div
        aria-busy="true"
        className="border-border bg-card w-full rounded-2xl border p-6 shadow-sm sm:p-8"
      >
        <div className="bg-muted h-5 w-28 animate-pulse rounded-full" />
        <div className="bg-muted mt-4 h-6 w-1/2 animate-pulse rounded" />
        <div className="mt-2 flex gap-3">
          <div className="bg-muted h-3 w-24 animate-pulse rounded" />
          <div className="bg-muted h-3 w-16 animate-pulse rounded" />
        </div>
      </div>

      <div
        aria-busy="true"
        className="border-border bg-card w-full rounded-2xl border p-6 shadow-sm"
      >
        <div className="bg-muted h-4 w-20 animate-pulse rounded" />
        <div className="bg-muted mt-3 h-3 w-[95%] animate-pulse rounded" />
        <div className="bg-muted mt-2 h-3 w-[88%] animate-pulse rounded" />
        <div className="bg-muted/60 mt-2 h-3 w-[64%] animate-pulse rounded" />
      </div>

      <div
        aria-busy="true"
        className="border-border bg-card w-full rounded-2xl border p-6 shadow-sm"
      >
        <div className="bg-muted h-4 w-16 animate-pulse rounded" />
        <div className="mt-4 flex items-center gap-3">
          <div className="bg-muted h-9 w-9 shrink-0 animate-pulse rounded-lg" />
          <div className="bg-muted h-3 w-2/5 animate-pulse rounded" />
        </div>
      </div>
    </output>
  );
}
