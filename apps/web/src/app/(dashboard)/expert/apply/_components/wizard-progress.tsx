'use client';

import { Check, Minus } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { STEP_CONFIG } from '../_actions/schemas';
import { useWizard } from './expert-application-context';

type DotStatus = 'completed' | 'active' | 'skipped' | 'future';

const DOT_STATUSES = {
  completed: 'bg-success text-success-foreground cursor-pointer hover:ring-2 hover:ring-primary/30',
  active: 'bg-primary text-primary-foreground',
  skipped: 'bg-muted text-muted-foreground cursor-pointer hover:ring-2 hover:ring-primary/30',
  future: 'bg-muted text-muted-foreground cursor-not-allowed opacity-60',
} as const;

const STATUS_ARIA_SUFFIX: Record<DotStatus, string> = {
  completed: ' (completed)',
  skipped: ' (skipped)',
  active: '',
  future: '',
};

function getStepDotStatus(index: number, currentStep: number, stepStatuses: string[]): DotStatus {
  if (index === currentStep) return 'active';
  if (stepStatuses[index] === 'completed') return 'completed';
  if (stepStatuses[index] === 'skipped') return 'skipped';
  return 'future';
}

function renderDotContent(status: DotStatus, index: number): React.ReactNode {
  if (status === 'completed') {
    return <Check className="h-4 w-4" />;
  }
  if (status === 'skipped') {
    return <Minus className="h-4 w-4" />;
  }
  return index + 1;
}

export function WizardProgress(): React.JSX.Element {
  const { currentStep, stepStatuses, goToStep } = useWizard();

  const completedCount = stepStatuses.filter((s) => s === 'completed' || s === 'skipped').length;
  const progressPercent =
    ((completedCount + (currentStep < STEP_CONFIG.length ? 0.5 : 0)) / STEP_CONFIG.length) * 100;

  return (
    <>
      {/* Desktop progress (>= 768px) */}
      <nav
        aria-label="Application progress"
        className="mx-auto mb-8 hidden w-full max-w-3xl md:block"
      >
        <div className="relative flex items-center justify-between">
          {/* Connecting lines */}
          <div className="absolute top-4 right-4 left-4 flex items-center">
            {STEP_CONFIG.slice(0, -1).map((step, i) => {
              const isCompleted = stepStatuses[i] === 'completed' || stepStatuses[i] === 'skipped';
              const isNextActive = i + 1 === currentStep;
              return (
                <div key={step.key} className="h-0.5 flex-1">
                  <div
                    className={cn(
                      'h-full transition-colors duration-300',
                      isCompleted && !isNextActive && 'bg-success',
                      isCompleted && isNextActive && 'from-success to-border bg-gradient-to-r',
                      !isCompleted && 'bg-border'
                    )}
                  />
                </div>
              );
            })}
          </div>

          {/* Dots */}
          {STEP_CONFIG.map((step, i) => {
            const status = getStepDotStatus(i, currentStep, stepStatuses);
            const isClickable = status === 'completed' || status === 'skipped';

            return (
              <div key={step.key} className="relative z-10 flex flex-col items-center">
                <motion.button
                  type="button"
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-300',
                    DOT_STATUSES[status]
                  )}
                  onClick={() => isClickable && goToStep(i)}
                  tabIndex={isClickable ? 0 : -1}
                  aria-current={i === currentStep ? 'step' : undefined}
                  aria-label={`Step ${i + 1}: ${step.label}${STATUS_ARIA_SUFFIX[status]}`}
                  whileTap={isClickable ? { scale: 0.95 } : undefined}
                  layout
                >
                  {renderDotContent(status, i)}
                </motion.button>
                <span
                  className={cn(
                    'mt-2 text-xs whitespace-nowrap transition-colors duration-200',
                    i === currentStep ? 'text-foreground font-medium' : 'text-muted-foreground'
                  )}
                >
                  {step.shortLabel}
                </span>
              </div>
            );
          })}
        </div>
      </nav>

      {/* Mobile progress (< 768px) */}
      <div className="mb-4 md:hidden">
        <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
          <motion.div
            className="bg-primary h-full rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(progressPercent, 100)}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
        <p className="text-muted-foreground mt-2 text-center text-xs">
          Step {currentStep + 1} of {STEP_CONFIG.length} &mdash;{' '}
          {STEP_CONFIG[currentStep]?.label ?? ''}
        </p>
      </div>
    </>
  );
}
