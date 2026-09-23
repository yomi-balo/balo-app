const ROW_KEYS = ['row-a', 'row-b'] as const;

/**
 * The Calendars card's loading state: two placeholder rows shaped like the ready rows (tile,
 * two text lines, a status pill), separated by the same divider. It renders inside the card,
 * so it brings no shell of its own. `<output>` + a visually-hidden label — not `role="status"`
 * (SonarCloud S6819). CSS pulse animation is already neutralised globally under
 * `prefers-reduced-motion: reduce` (`globals.css`), so no per-component reduced-motion work is
 * needed here.
 */
export function CalendarConnectionsSkeleton(): React.JSX.Element {
  return (
    <output aria-label="Loading" className="block">
      <div className="divide-border/60 flex flex-col divide-y">
        {ROW_KEYS.map((key) => (
          <div key={key} className="flex items-center gap-3 py-3.5 first:pt-0 last:pb-0">
            <div className="bg-muted size-7 shrink-0 animate-pulse rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <div className="bg-muted h-3 w-2/5 animate-pulse rounded" />
              <div className="bg-muted/60 h-2.5 w-3/5 animate-pulse rounded" />
            </div>
            <div className="bg-muted h-5 w-20 shrink-0 animate-pulse rounded-full" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </output>
  );
}
