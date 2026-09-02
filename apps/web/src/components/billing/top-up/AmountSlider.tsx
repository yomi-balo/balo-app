'use client';

import { useCallback } from 'react';
import { Sparkles } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import {
  MIN_AMOUNT_MINOR,
  MAX_AMOUNT_MINOR,
  STEP_MINOR,
  GOAL_AMOUNT_MINOR,
  TIERS_MINOR,
  formatAudShort,
  timeStr,
} from '@/lib/credit/display-constants';

/**
 * How far the amount has travelled from the floor toward the A$5,000 goal, clamped to 0…1.
 * Drives a continuous blue/violet → green warming of the slider fill, so the reward reads as
 * approached rather than switched on. Presentation only.
 */
function goalProgress(amountMinor: number): number {
  const span = GOAL_AMOUNT_MINOR - MIN_AMOUNT_MINOR;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (amountMinor - MIN_AMOUNT_MINOR) / span));
}

interface AmountSliderProps {
  readonly amountMinor: number;
  readonly promoMinor: number;
  readonly onAmountChange: (minor: number) => void;
}

const NEAR_GOAL_MINOR = 350_000;

interface TierButtonProps {
  readonly tierMinor: number;
  readonly selected: boolean;
  readonly isGoal: boolean;
  readonly onSelect: (minor: number) => void;
}

function AmountTierButton({ tierMinor, selected, isGoal, onSelect }: Readonly<TierButtonProps>) {
  const handleClick = useCallback(() => onSelect(tierMinor), [onSelect, tierMinor]);
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={selected}
      className={cn(
        'focus-visible:ring-ring rounded-xl border p-3 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none',
        selected && isGoal && 'border-success bg-success/5',
        selected && !isGoal && 'border-primary bg-primary/5',
        !selected && 'border-border bg-card hover:bg-accent/40'
      )}
    >
      <div className="text-foreground text-base font-semibold">{formatAudShort(tierMinor)}</div>
      <div
        className={cn(
          'mt-0.5 text-[11px] font-semibold',
          selected && isGoal && 'text-success',
          selected && !isGoal && 'text-primary',
          !selected && 'text-muted-foreground'
        )}
      >
        ~{timeStr(tierMinor)}
      </div>
    </button>
  );
}

/**
 * BAL-377 amount selector — the shadcn/Radix Slider (A$300…A$10,000, snapping to A$100) with
 * a gradient fill that locks green at the A$5,000 goal, an encouraging caption, and three
 * quick-pick tiers. All figures are presentation-only.
 */
export function AmountSlider({
  amountMinor,
  promoMinor,
  onAmountChange,
}: Readonly<AmountSliderProps>) {
  const hitGoal = amountMinor >= GOAL_AMOUNT_MINOR;
  const nearGoal = !hitGoal && amountMinor >= NEAR_GOAL_MINOR;
  const creditedMinor = amountMinor + promoMinor;

  const handleValueChange = useCallback(
    (values: number[]) => {
      const [next] = values;
      if (next === undefined) return;
      onAmountChange(next);
    },
    [onAmountChange]
  );

  return (
    <div>
      <div className="text-foreground mb-2.5 text-sm font-semibold">Choose an amount</div>

      <Slider
        value={[amountMinor]}
        min={MIN_AMOUNT_MINOR}
        max={MAX_AMOUNT_MINOR}
        step={STEP_MINOR}
        onValueChange={handleValueChange}
        aria-label="Top-up amount"
        // Tokens mixed in OKLCH — never a hex lerp (the prototype's `lerpHex`). The two-stop
        // `from-primary to-violet-600` gradient below stays the base declaration, so an engine
        // without `color-mix` simply keeps today's look rather than losing the fill.
        style={
          {
            '--topup-fill-from': `color-mix(in oklch, var(--primary), var(--success) ${Math.round(goalProgress(amountMinor) * 70)}%)`,
            '--topup-fill-to': `color-mix(in oklch, var(--color-violet-600), var(--success) ${Math.round(goalProgress(amountMinor) * 100)}%)`,
          } as React.CSSProperties
        }
        className={cn(
          '[&_[data-slot=slider-track]]:h-2',
          // ~22px visual thumb with a ≥44px transparent hit area (a `::before` pad extends the
          // pointer target 11px on every side: 22 + 11 + 11 = 44) — mobile tap-target spec,
          // without changing the desktop look.
          '[&_[data-slot=slider-thumb]]:relative [&_[data-slot=slider-thumb]]:size-[22px]',
          "[&_[data-slot=slider-thumb]]:before:absolute [&_[data-slot=slider-thumb]]:before:-inset-[11px] [&_[data-slot=slider-thumb]]:before:rounded-full [&_[data-slot=slider-thumb]]:before:content-['']",
          hitGoal
            ? '[&_[data-slot=slider-range]]:bg-success [&_[data-slot=slider-thumb]]:border-success [&_[data-slot=slider-thumb]]:ring-success/30 [&_[data-slot=slider-range]]:bg-none'
            : // Base: the shipped two-stop gradient. Then, where `color-mix` is supported, the
              // same two stops warmed toward `--success` as the goal approaches.
              '[&_[data-slot=slider-range]]:from-primary [&_[data-slot=slider-range]]:bg-gradient-to-r [&_[data-slot=slider-range]]:to-violet-600 [&_[data-slot=slider-range]]:supports-[color:color-mix(in_oklch,red,blue)]:from-(--topup-fill-from) [&_[data-slot=slider-range]]:supports-[color:color-mix(in_oklch,red,blue)]:to-(--topup-fill-to)'
        )}
      />

      <div className="text-muted-foreground mt-1.5 flex justify-between text-[11px] font-semibold">
        <span>{formatAudShort(MIN_AMOUNT_MINOR)}</span>
        <span>{formatAudShort(MAX_AMOUNT_MINOR)}</span>
      </div>

      <div className="mt-2.5 min-h-5" aria-live="polite">
        {hitGoal ? (
          <span className="border-success/40 bg-success/10 text-success inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold">
            <Sparkles className="size-3.5" strokeWidth={2.5} aria-hidden="true" /> Nice —{' '}
            {timeStr(creditedMinor)} of expert time, ready whenever you need it.
          </span>
        ) : (
          <span
            className={cn(
              'text-xs font-medium',
              nearGoal ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {nearGoal
              ? 'Almost there — a little more unlocks your biggest block of time →'
              : 'Slide right — the more you add, the more expert time on tap →'}
          </span>
        )}
      </div>

      <div className="mt-3.5 grid grid-cols-3 gap-2.5">
        {TIERS_MINOR.map((tier) => (
          <AmountTierButton
            key={tier}
            tierMinor={tier}
            selected={amountMinor === tier}
            isGoal={tier === GOAL_AMOUNT_MINOR}
            onSelect={onAmountChange}
          />
        ))}
      </div>
    </div>
  );
}
