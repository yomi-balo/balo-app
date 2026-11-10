import { cn } from '@/lib/utils';
import type { MilestoneTimeView } from '@/lib/engagement/time-view';

type Tone = MilestoneTimeView['tone'];

const FILL_CLASS: Record<Tone, string> = {
  ok: 'bg-primary',
  near: 'bg-warning',
  over: 'bg-destructive',
};

const REMAINING_CLASS: Record<Tone, string> = {
  ok: 'text-muted-foreground',
  near: 'text-warning-strong',
  over: 'text-destructive-strong',
};

interface HoursBarProps {
  time: Pick<
    MilestoneTimeView,
    | 'milestoneTitle'
    | 'estimatedMinutes'
    | 'tone'
    | 'fillPercent'
    | 'loggedLabel'
    | 'remainingLabel'
  >;
}

/**
 * A milestone's logged hours against its soft estimate: primary until 80%, warning from
 * there, destructive once over. Going over is allowed but never silent, so the over state
 * also says so in words. A milestone with no estimate shows the hours alone, with no track.
 */
export function HoursBar({ time }: Readonly<HoursBarProps>): React.JSX.Element {
  const { tone, fillPercent, loggedLabel, remainingLabel, estimatedMinutes, milestoneTitle } = time;
  return (
    <div className="mt-3 max-w-md">
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs">
        <span className="text-muted-foreground font-medium">{loggedLabel}</span>
        {remainingLabel !== null && (
          <span className={cn('font-medium', REMAINING_CLASS[tone])}>{remainingLabel}</span>
        )}
      </div>
      {estimatedMinutes !== null && (
        <div
          role="progressbar"
          aria-label={`Hours logged on ${milestoneTitle}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fillPercent}
          aria-valuetext={loggedLabel}
          className="bg-muted mt-1.5 h-1.5 overflow-hidden rounded-full"
        >
          <div
            data-tone={tone}
            className={cn('h-full rounded-full transition-all', FILL_CLASS[tone])}
            style={{ width: `${fillPercent}%` }}
          />
        </div>
      )}
    </div>
  );
}
