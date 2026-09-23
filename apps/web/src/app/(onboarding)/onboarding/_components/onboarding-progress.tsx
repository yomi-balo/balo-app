import { cn } from '@/lib/utils';

interface OnboardingProgressProps {
  current: number;
  total: number;
}

export function onboardingStepLabel(current: number, total: number): string {
  return `Step ${current} of ${total}`;
}

/**
 * The header's segmented step indicator. Full-width under the logo row on mobile; a fixed
 * run of segments centred in the header on desktop, captioned with the step count. The
 * mobile caption sits above the step heading instead (rendered by the wizard), so the
 * caption here is desktop-only. Both captions are `aria-hidden` — the progressbar's
 * `aria-valuetext` already announces the same words.
 */
export function OnboardingProgress({
  current,
  total,
}: Readonly<OnboardingProgressProps>): React.JSX.Element {
  const label = onboardingStepLabel(current, total);

  return (
    <div className="flex w-full flex-col items-center gap-2.5 md:w-auto">
      <div
        role="progressbar"
        aria-label="Onboarding progress"
        aria-valuenow={current}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuetext={label}
        className="grid w-full auto-cols-fr grid-flow-col gap-1.5 md:flex md:w-auto"
      >
        {Array.from({ length: total }, (_, i) => {
          const step = i + 1;
          return (
            <div
              key={step}
              className={cn(
                'h-1 rounded-full transition-colors duration-300 md:w-9',
                step < current && 'bg-primary/40',
                step === current && 'bg-primary',
                step > current && 'bg-border'
              )}
            />
          );
        })}
      </div>
      <p
        aria-hidden="true"
        className="text-muted-foreground hidden text-[13px] leading-[1.3] font-medium md:block"
      >
        {label}
      </p>
    </div>
  );
}

/** Placeholder for the progress slot while the wizard streams in. */
export function OnboardingProgressSkeleton(): React.JSX.Element {
  return (
    <div className="flex w-full flex-col items-center gap-2.5 md:w-auto">
      <div className="bg-muted h-1 w-full animate-pulse rounded-full md:w-40" />
      <div className="bg-muted hidden h-3 w-20 animate-pulse rounded md:block" />
    </div>
  );
}
