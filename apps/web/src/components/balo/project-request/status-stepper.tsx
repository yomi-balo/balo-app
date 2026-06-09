import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';

interface StatusStep {
  key: ProjectRequestStatus;
  short: string;
}

/**
 * The 8 display steps of the request pipeline (the prototype's `STATUSES`). `draft`
 * is a pre-submit state not shown on the stepper — the first visible step is
 * `requested`.
 */
const STATUS_STEPS: readonly StatusStep[] = [
  { key: 'requested', short: 'Requested' },
  { key: 'exploratory_meeting_requested', short: 'Exploratory' },
  { key: 'experts_invited', short: 'Invited' },
  { key: 'eoi_submitted', short: 'EOIs in' },
  { key: 'proposal_requested', short: 'Prop. req.' },
  { key: 'proposal_submitted', short: 'Proposals in' },
  { key: 'accepted', short: 'Accepted' },
  { key: 'kickoff_approved', short: 'Kickoff' },
];

interface StatusStepperProps {
  current: ProjectRequestStatus;
}

/**
 * Display-only pipeline stepper (the prototype's reviewer `onPick` is NOT
 * shipped). Highlights the current step; earlier steps render as done. Scrolls
 * horizontally on narrow viewports.
 */
export function StatusStepper({ current }: Readonly<StatusStepperProps>): React.JSX.Element {
  // `draft` precedes `requested` — clamp it to index 0 so nothing is "done".
  const currentIndex = Math.max(
    0,
    STATUS_STEPS.findIndex((s) => s.key === current)
  );

  return (
    <ol className="flex items-center overflow-x-auto py-1" aria-label="Request progress">
      {STATUS_STEPS.map((step, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <li key={step.key} className="flex shrink-0 items-center">
            <div
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5',
                active && 'bg-primary/10'
              )}
              aria-current={active ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                  done && 'bg-primary text-primary-foreground',
                  active && 'border-primary text-primary border-2',
                  !done && !active && 'bg-muted text-muted-foreground border-border border'
                )}
              >
                {done ? <Check className="h-3 w-3" aria-hidden="true" /> : i + 1}
              </span>
              <span
                className={cn(
                  'text-xs whitespace-nowrap',
                  active && 'text-primary font-semibold',
                  done && 'text-muted-foreground font-medium',
                  !done && !active && 'text-muted-foreground'
                )}
              >
                {step.short}
              </span>
            </div>
            {i < STATUS_STEPS.length - 1 && (
              <span
                className={cn('mx-0.5 h-px w-3.5 shrink-0', done ? 'bg-primary' : 'bg-border')}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
