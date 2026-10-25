import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type {
  EngagementProgressView,
  ProgressSegmentView,
  ReviewPillView,
} from '@/lib/engagement/engagement-view';
import { GRADIENT } from './milestone-row';

interface EngagementProgressProps {
  progress: EngagementProgressView;
}

type SegmentTone = ProgressSegmentView['tone'];

const SEGMENT_CLASS: Record<SegmentTone, string> = {
  completed: GRADIENT,
  in_progress: 'bg-primary/60',
  pending: 'bg-muted',
  reopened: 'bg-warning',
};

const LEGEND_DOT_CLASS: Record<SegmentTone, string> = {
  completed: 'bg-violet',
  reopened: 'bg-warning',
  in_progress: 'bg-primary/60',
  pending: 'bg-muted-foreground/30',
};

/** Legend order and wording; a tone with no milestones is left out. */
const LEGEND: readonly { tone: SegmentTone; label: string }[] = [
  { tone: 'completed', label: 'Completed' },
  { tone: 'reopened', label: 'Changes requested' },
  { tone: 'in_progress', label: 'In progress' },
  { tone: 'pending', label: 'Not started' },
];

const PILL_CLASS: Record<ReviewPillView['tone'], string> = {
  warning: 'border-warning/25 bg-warning/10 text-foreground',
  violet: 'border-violet/25 bg-violet/10 text-foreground',
  success: 'border-success/25 bg-success/10 text-foreground',
};

/**
 * Whole-project delivery progress: "{done} of {total} milestones completed", the
 * project-level review pill (changes requested / ready for review / accepted), one bar
 * segment per milestone (a milestone the client sent back reads amber, not "in progress"),
 * a legend of the tones in use, and — on the client lens — the review explainer. No
 * percentage is rendered: it would read as "nearly done" on a project that has been sent
 * back. The native `<progress>` stays, visually hidden, for assistive tech. Read-only.
 */
export function EngagementProgress({
  progress,
}: Readonly<EngagementProgressProps>): React.JSX.Element {
  const { done, total, pct, reviewCopy, reviewPill, segments } = progress;
  const legend = LEGEND.map((entry) => ({
    ...entry,
    count: segments.filter((segment) => segment.tone === entry.tone).length,
  })).filter((entry) => entry.count > 0);

  return (
    <Card className="border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <p className="text-foreground text-xl font-semibold">
            {done} of {total}
          </p>
          <p className="text-muted-foreground text-sm">
            {total === 1 ? 'milestone' : 'milestones'} completed
          </p>
          {reviewPill !== null && (
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
                PILL_CLASS[reviewPill.tone]
              )}
            >
              {reviewPill.label}
            </span>
          )}
        </div>
        {legend.length > 0 && (
          <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {legend.map((entry) => (
              <li key={entry.tone} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn('size-2 rounded-full', LEGEND_DOT_CLASS[entry.tone])}
                />
                {entry.label} {entry.count}
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Native <progress> carries the semantics/accessible value (visually hidden);
          the segmented bar below is the visual. */}
      <progress className="sr-only" value={pct} max={100} aria-label="Milestones completed" />
      <div role="list" aria-label="Milestone progress" className="mt-4 flex gap-1.5">
        {segments.map((segment) => (
          <div
            key={segment.id}
            role="listitem"
            aria-label={segment.label}
            title={segment.label}
            className={cn('h-2 flex-1 rounded-full transition-colors', SEGMENT_CLASS[segment.tone])}
          />
        ))}
      </div>
      {reviewCopy !== null && (
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">{reviewCopy}</p>
      )}
    </Card>
  );
}
