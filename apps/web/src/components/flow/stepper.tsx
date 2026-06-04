'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface FlowStep {
  key: string;
  label: string;
}

interface FlowStepperProps {
  steps: FlowStep[];
  /** Key of the active step. */
  current: string;
  /**
   * When provided, completed steps render as buttons that call `onJump(key)`.
   * Omit for a read-only (non-interactive) stepper.
   */
  onJump?: (key: string) => void;
}

/**
 * Generic flow stepper shared by the write-flow drawers (BAL-252/253/255).
 * Completed steps (before the current one) are clickable when `onJump` is
 * provided; the active step is emphasised; future steps are muted. Each flow
 * passes its own `steps` array.
 */
export function FlowStepper({
  steps,
  current,
  onJump,
}: Readonly<FlowStepperProps>): React.JSX.Element {
  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.key === current)
  );

  return (
    <ol className="flex items-center gap-2">
      {steps.map((step, index) => {
        const isActive = index === currentIndex;
        const isDone = index < currentIndex;
        const isClickable = isDone && onJump !== undefined;

        const circle = (
          <span
            aria-hidden="true"
            className={cn(
              'flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold',
              isDone && 'from-primary bg-gradient-to-r to-violet-600 text-white dark:to-violet-500',
              isActive && 'bg-primary/10 text-primary border-primary/40 border',
              !isDone && !isActive && 'bg-muted text-muted-foreground'
            )}
          >
            {isDone ? <Check className="h-3 w-3" /> : index + 1}
          </span>
        );

        const label = (
          <span
            className={cn(
              'text-[13px]',
              isActive ? 'text-foreground font-semibold' : 'text-muted-foreground font-medium',
              isClickable && 'underline-offset-[3px] hover:underline'
            )}
          >
            {step.label}
          </span>
        );

        return (
          <li key={step.key} className="flex items-center gap-2">
            {isClickable ? (
              <button
                type="button"
                onClick={() => onJump(step.key)}
                title={`Back to ${step.label}`}
                className="focus-visible:ring-ring flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:outline-none"
              >
                {circle}
                {label}
              </button>
            ) : (
              <span
                className="flex items-center gap-2"
                aria-current={isActive ? 'step' : undefined}
              >
                {circle}
                {label}
              </span>
            )}
            {index < steps.length - 1 && <span className="bg-border h-px w-[18px]" />}
          </li>
        );
      })}
    </ol>
  );
}
