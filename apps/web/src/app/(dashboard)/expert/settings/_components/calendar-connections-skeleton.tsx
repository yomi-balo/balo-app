import { Card } from '@/components/ui/card';

const ROW_KEYS = ['row-a', 'row-b', 'row-c'] as const;

/**
 * The loading skeleton, mirroring the prototype's `LoadingView`: one account-header row
 * followed by a three-row busy-list skeleton, both inside a card shell matching the ready-state
 * layout. `<output>` + a visually-hidden label — not `role="status"` (SonarCloud S6819). CSS
 * pulse animation is already neutralised globally under `prefers-reduced-motion: reduce`
 * (`globals.css`), so no per-component reduced-motion work is needed here.
 */
export function CalendarConnectionsSkeleton(): React.JSX.Element {
  return (
    <output aria-label="Loading" className="block">
      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="bg-muted h-10 w-10 shrink-0 animate-pulse rounded-xl" />
          <div className="flex-1 space-y-2">
            <div className="bg-muted h-3 w-2/5 animate-pulse rounded" />
            <div className="bg-muted/60 h-2.5 w-1/4 animate-pulse rounded" />
          </div>
          <div className="bg-muted h-6 w-20 shrink-0 animate-pulse rounded-full" />
        </div>
        <div className="space-y-1 px-5 py-4">
          {ROW_KEYS.map((key) => (
            <div key={key} className="flex items-center gap-3 py-2">
              <div className="bg-muted h-2.5 w-2.5 shrink-0 animate-pulse rounded-full" />
              <div className="bg-muted h-3 flex-1 animate-pulse rounded" />
              <div className="bg-muted h-5 w-9 shrink-0 animate-pulse rounded-full" />
            </div>
          ))}
        </div>
      </Card>
      <span className="sr-only">Loading…</span>
    </output>
  );
}
