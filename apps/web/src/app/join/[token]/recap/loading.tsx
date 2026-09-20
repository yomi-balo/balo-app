/**
 * BAL-492 — the guest recap INDEX's skeleton, drawn in the PAGE'S OWN SHAPE (a title bar, then
 * three row stubs) rather than a spinner, so the layout does not jump when the real content
 * lands. Mirrors `[meetingId]/loading.tsx` exactly, including its accessibility posture.
 *
 * ⚠ IT ANNOUNCES ITSELF. `<output>` carries an implicit polite live region (and NOT
 * `role="status"`, which SonarCloud flags under S6819); the `sr-only` line is what it announces.
 *
 * ⚠⚠ `aria-busy` SITS ON THE **DECORATIVE WRAPPER**, NEVER ON THE `<output>`. `aria-busy`
 * SUPPRESSES a live region's own announcements — on the `<output>` it would silence the very
 * "Loading your recaps…" line this element exists to announce.
 */

/** The three row stubs' per-row variation — the last is dimmed to read as trailing off. */
const ROW_STUBS: ReadonlyArray<{
  readonly key: string;
  readonly barWidth: string;
  readonly dimmed: boolean;
}> = [
  { key: 'row-a', barWidth: 'w-2/5', dimmed: false },
  { key: 'row-b', barWidth: 'w-1/3', dimmed: false },
  { key: 'row-c', barWidth: 'w-2/5', dimmed: true },
];

export default function GuestRecapIndexLoading(): React.JSX.Element {
  return (
    <output className="mx-auto block w-full max-w-md space-y-5">
      <span className="sr-only">Loading your recaps…</span>

      <div
        aria-busy="true"
        className="border-border bg-card w-full rounded-2xl border p-6 shadow-sm sm:p-8"
      >
        <div className="bg-muted h-6 w-1/2 animate-pulse rounded" />

        <div className="mt-4 space-y-1">
          {ROW_STUBS.map(({ key, barWidth, dimmed }) => (
            <div key={key} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
              <div
                className={`${dimmed ? 'bg-muted/60' : 'bg-muted'} h-6 w-24 shrink-0 animate-pulse rounded-full`}
              />
              <div
                className={`${dimmed ? 'bg-muted/60' : 'bg-muted'} h-3 ${barWidth} animate-pulse rounded`}
              />
            </div>
          ))}
        </div>
      </div>
    </output>
  );
}
