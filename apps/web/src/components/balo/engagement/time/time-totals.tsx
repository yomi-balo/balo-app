import { cn } from '@/lib/utils';
import type { TimeTotalsView } from '@/lib/engagement/time-view';

interface TimeTotalsProps {
  totals: TimeTotalsView;
}

/**
 * The project-wide hours, set under the delivery plan: logged against the summed milestone estimates, and, when the
 * billing cadence and kickoff are known, the current billing period. Hours only — never a
 * rate or an amount.
 */
export function TimeTotals({ totals }: Readonly<TimeTotalsProps>): React.JSX.Element {
  const { loggedLabel, fillPercent, over, period } = totals;
  return (
    <section aria-label="Hours on this project" className="border-border mt-5 border-t pt-5">
      <div className={cn('grid gap-5', period !== null && 'sm:grid-cols-2')}>
        <div>
          <p className="text-foreground text-sm font-semibold">{loggedLabel}</p>
          {fillPercent !== null && (
            <div
              role="progressbar"
              aria-label="Hours logged against the estimate"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={fillPercent}
              className="bg-muted mt-2 h-2 overflow-hidden rounded-full"
            >
              <div
                data-over={over}
                className={cn(
                  'h-full rounded-full transition-all',
                  over ? 'bg-destructive' : 'from-primary bg-gradient-to-r to-violet-600'
                )}
                style={{ width: `${fillPercent}%` }}
              />
            </div>
          )}
        </div>
        {period !== null && (
          <div>
            <p className="text-foreground text-sm font-semibold">
              {period.hoursLabel}{' '}
              <span className="text-muted-foreground font-normal">this billing period</span>
            </p>
            <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">{period.detail}</p>
          </div>
        )}
      </div>
    </section>
  );
}
