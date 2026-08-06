/**
 * The review-landing skeleton (BAL-390). Deliberately drawn in the PAGE'S OWN SHAPE —
 * context card, five 48px star blocks, note field, button — rather than a spinner, so
 * the layout does not jump when the real content lands and the recipient can already
 * see what is being asked of them.
 *
 * ⚠ IT ANNOUNCES ITSELF. The skeleton bars are decorative, so an `aria-hidden` wrapper
 * alone would hand a screen-reader user a silent, empty page for the whole resolve —
 * and this route is a cold, uncached, `force-dynamic` token lookup, so that pause is
 * real. `<output>` carries an implicit polite live region (and NOT `role="status"`,
 * which SonarCloud flags under S6819); the `sr-only` line is what it announces. Same
 * shape as the shipped `(dashboard)/redeem/loading.tsx`.
 */
export default function ReviewLandingLoading(): React.JSX.Element {
  return (
    <output aria-busy="true" className="mx-auto block w-full max-w-md">
      <span className="sr-only">Loading your review…</span>
      <div className="border-border bg-card w-full rounded-2xl border p-6 shadow-sm sm:p-8">
        <div className="flex items-center gap-3">
          <div className="bg-muted h-11 w-11 animate-pulse rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
            <div className="bg-muted h-3 w-1/2 animate-pulse rounded" />
          </div>
        </div>

        <div className="bg-muted mt-6 h-4 w-3/4 animate-pulse rounded" />

        <div className="mt-6 flex justify-center gap-1">
          {[0, 1, 2, 3, 4].map((slot) => (
            <div key={slot} className="bg-muted h-12 w-12 animate-pulse rounded-xl" />
          ))}
        </div>
        <div className="bg-muted mx-auto mt-3 h-3 w-32 animate-pulse rounded" />

        <div className="bg-muted mt-6 h-24 w-full animate-pulse rounded-xl" />
        <div className="bg-muted mt-4 h-11 w-full animate-pulse rounded-lg" />
      </div>
    </output>
  );
}
