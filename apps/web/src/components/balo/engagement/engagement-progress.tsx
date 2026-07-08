import { Card } from '@/components/ui/card';
import type { EngagementProgressView } from '@/lib/engagement/engagement-view';

interface EngagementProgressProps {
  progress: EngagementProgressView;
}

/**
 * Whole-project delivery progress. Renders "{done} of {total} milestones
 * completed", an accessible gradient progress bar (the signature blue→violet
 * device), and — on the client lens only — the review explainer copy. Read-only:
 * no controls, purely informational.
 */
export function EngagementProgress({
  progress,
}: Readonly<EngagementProgressProps>): React.JSX.Element {
  const { done, total, pct, reviewCopy } = progress;

  return (
    <Card className="border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-foreground text-xl font-semibold">
          {done} of {total}
        </p>
        <p className="text-muted-foreground text-sm">
          {total === 1 ? 'milestone' : 'milestones'} completed
        </p>
        <span className="text-primary ml-auto text-xs font-semibold">{pct}%</span>
      </div>
      <div className="bg-muted mt-3 h-2 overflow-hidden rounded-full">
        {/* Native <progress> carries the semantics/accessible value (visually
            hidden); the gradient bar below is the decorative signature fill. */}
        <progress className="sr-only" value={pct} max={100} aria-label="Milestones completed" />
        <div
          aria-hidden="true"
          className="from-primary h-full rounded-full bg-gradient-to-br to-violet-600 transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {reviewCopy !== null && (
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">{reviewCopy}</p>
      )}
    </Card>
  );
}
