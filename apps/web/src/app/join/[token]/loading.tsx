/**
 * The join-landing skeleton (BAL-408). Deliberately drawn in the PAGE'S OWN SHAPE — the
 * context eyebrow, the headline, the when/who rows, the people row and the access-scope
 * disclosure block — rather than a spinner, so the layout does not jump when the real
 * content lands and the guest can already see what kind of thing they are looking at.
 *
 * ⚠ IT ANNOUNCES ITSELF. The skeleton bars are decorative, so an `aria-hidden` wrapper
 * alone would hand a screen-reader user a silent, empty page for the whole resolve — and
 * this route is a cold, uncached, `force-dynamic` token lookup that fans out to the
 * context, roster and party reads, so that pause is real. `<output>` carries an implicit
 * polite live region (and NOT `role="status"`, which SonarCloud flags under S6819); the
 * `sr-only` line is what it announces. Same shape as the shipped `/review/[token]` and
 * `(dashboard)/redeem` skeletons.
 */
export default function JoinLandingLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="mx-auto block w-full max-w-md">
      <span className="sr-only">Loading your invitation…</span>
      <div className="border-border bg-card w-full rounded-2xl border p-6 shadow-sm sm:p-8">
        <div className="bg-muted h-5 w-28 animate-pulse rounded-full" />
        <div className="bg-muted mt-4 h-6 w-2/3 animate-pulse rounded" />
        <div className="bg-muted mt-2 h-4 w-1/2 animate-pulse rounded" />

        <div className="border-border mt-6 space-y-3 border-t pt-5">
          {['when', 'invited-by', 'people'].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <div className="bg-muted h-8 w-8 shrink-0 animate-pulse rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <div className="bg-muted h-3 w-20 animate-pulse rounded" />
                <div className="bg-muted h-4 w-3/5 animate-pulse rounded" />
              </div>
            </div>
          ))}
        </div>

        <div className="bg-muted mt-6 h-16 w-full animate-pulse rounded-xl" />
      </div>
    </output>
  );
}
