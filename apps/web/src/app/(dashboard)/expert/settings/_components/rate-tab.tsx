'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, DollarSign, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { track, EXPERT_RATE_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import { PLATFORM_PRICING } from '@/lib/constants/platform';
import {
  centsToDollars,
  dollarsToCents,
  formatCurrency,
  calculateClientRate,
  perMinuteToPerHour,
  perHourToPerMinuteCents,
} from '@/lib/utils/currency';
import { saveRateAction } from '../_actions/save-rate';
import { SettingsPageHeader } from './settings-page-header';

interface RateTabProps {
  /** Current saved rate in cents, or null if not yet set */
  initialRateCents: number | null;
}

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

type RateUnit = 'minute' | 'hour';

const UNIT_OPTIONS: ReadonlyArray<{ value: RateUnit; label: string }> = [
  { value: 'minute', label: 'Per minute' },
  { value: 'hour', label: 'Per hour' },
];

/** The input text for a stored per-minute cents value, expressed in the given unit. */
function inputTextFor(cents: number, unit: RateUnit): string {
  if (!cents) return '';
  const shown = unit === 'hour' ? perMinuteToPerHour(cents) : cents;
  return centsToDollars(shown).toFixed(2);
}

interface RateUnitToggleProps {
  unit: RateUnit;
  onChange: (next: RateUnit) => void;
}

/**
 * Per minute / per hour input-mode switch. A radiogroup (one region, two ways to enter the
 * same rate), not a tablist: roving tabIndex plus Arrow/Home/End on each radio, which move
 * and select in one step.
 */
function RateUnitToggle({ unit, onChange }: Readonly<RateUnitToggleProps>): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  const focusOption = useCallback((index: number) => {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[index]?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const current = UNIT_OPTIONS.findIndex((option) => option.value === unit);
      if (current === -1) return;
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (current + 1) % UNIT_OPTIONS.length;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (current - 1 + UNIT_OPTIONS.length) % UNIT_OPTIONS.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = UNIT_OPTIONS.length - 1;
      }
      if (nextIndex === null) return;
      const next = UNIT_OPTIONS[nextIndex];
      if (next === undefined) return;
      event.preventDefault();
      onChange(next.value);
      focusOption(nextIndex);
    },
    [unit, onChange, focusOption]
  );

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label="Enter your rate"
      className="bg-muted inline-flex gap-1 rounded-[10px] p-[3px]"
    >
      {UNIT_OPTIONS.map((option) => {
        const isActive = option.value === unit;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              'focus-visible:ring-ring min-h-8 rounded-lg px-3 text-xs font-semibold transition-colors outline-none focus-visible:ring-2',
              isActive
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface ConversionLineProps {
  unit: RateUnit;
  rateCents: number;
  hourlyCents: number;
  wasRounded: boolean;
}

/** The line under the input: the other unit, or the rounding explanation. Empty until a rate is set. */
function ConversionLine({
  unit,
  rateCents,
  hourlyCents,
  wasRounded,
}: Readonly<ConversionLineProps>): React.JSX.Element | null {
  if (rateCents <= 0) return null;
  if (unit === 'minute') {
    return (
      <>
        That&apos;s{' '}
        <span className="text-foreground font-semibold">{formatCurrency(hourlyCents)}/hour</span>{' '}
        take-home
      </>
    );
  }
  if (wasRounded) {
    return (
      <>
        You&apos;re paid per minute, so this saves as{' '}
        <span className="text-foreground font-semibold">{formatCurrency(rateCents)}/minute</span> (
        {formatCurrency(hourlyCents)}/hour) take-home
      </>
    );
  }
  return (
    <>
      That&apos;s{' '}
      <span className="text-foreground font-semibold">{formatCurrency(rateCents)}/minute</span>{' '}
      take-home
    </>
  );
}

export function RateTab({ initialRateCents }: RateTabProps): React.JSX.Element {
  const [unit, setUnit] = useState<RateUnit>('minute');
  const [rateInput, setRateInput] = useState<string>(() =>
    inputTextFor(initialRateCents ?? 0, 'minute')
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const conversionId = useId();

  // All derived — no useEffect, no extra state
  const enteredCents = dollarsToCents(parseFloat(rateInput) || 0);
  const rateCents = unit === 'hour' ? perHourToPerMinuteCents(enteredCents) : enteredCents;
  const hourlyCents = perMinuteToPerHour(rateCents);
  const wasRounded = unit === 'hour' && enteredCents > 0 && hourlyCents !== enteredCents;
  const clientRateCents = calculateClientRate(rateCents);
  const hourlyClientCents = perMinuteToPerHour(clientRateCents);

  const maxRateCents = PLATFORM_PRICING.MAX_RATE_CENTS;
  let validationError: string | null = null;
  if (rateCents > maxRateCents) {
    validationError =
      unit === 'hour'
        ? `Max rate is ${formatCurrency(perMinuteToPerHour(maxRateCents))}/hour`
        : `Max rate is ${formatCurrency(maxRateCents)}/min`;
  } else if (rateInput !== '' && rateCents <= 0) {
    validationError = 'Rate must be greater than zero';
  }

  const isSaveDisabled =
    isSubmitting ||
    rateCents <= 0 ||
    rateCents === (initialRateCents ?? 0) ||
    validationError !== null;

  function handleRateChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const value = e.target.value;
    // Allow empty string (clearing the field)
    if (value === '') {
      setRateInput('');
      return;
    }
    // Only allow digits and at most one decimal point, max 2 decimal places
    if (/^\d*\.?\d{0,2}$/.test(value)) {
      setRateInput(value);
    }
  }

  function handleUnitChange(next: RateUnit): void {
    if (next === unit) return;
    // Re-render from cents, never from the typed text, so a toggle can't change the rate.
    setRateInput(inputTextFor(rateCents, next));
    setUnit(next);
  }

  async function handleSave(): Promise<void> {
    if (isSaveDisabled) return;
    setIsSubmitting(true);
    try {
      const result = await saveRateAction({ ratePerMinuteCents: rateCents });
      if (result.success) {
        // Show what was saved: a rounded hourly amount becomes the amount it saves as.
        setRateInput(inputTextFor(rateCents, unit));
        toast.success(
          unit === 'hour'
            ? `Rate saved — ${formatCurrency(hourlyCents)}/hour`
            : `Rate saved — ${formatCurrency(rateCents)}/min`
        );
        track(EXPERT_RATE_EVENTS.RATE_SAVED, {
          rate_per_minute_cents: rateCents,
          is_initial_setup: !initialRateCents || initialRateCents === 0,
          input_unit: unit,
          was_rounded: wasRounded,
        });
      } else {
        toast.error(result.error ?? 'Failed to save rate');
      }
    } catch {
      toast.error('Failed to save rate. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  // Display values
  const clientRatePerMin = centsToDollars(clientRateCents).toFixed(2);
  const clientRatePerHour = formatCurrency(hourlyClientCents);

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show">
      <motion.div variants={itemVariants} className="mb-8">
        <SettingsPageHeader
          icon={DollarSign}
          color="#059669"
          title="Set Your Rate"
          description={
            <>
              This is your take-home rate. Clients see a higher rate that includes Balo&apos;s
              service fee.
            </>
          }
        />
      </motion.div>

      {/* Rate input card */}
      <motion.div variants={itemVariants}>
        <Card className="p-8">
          {/* Section label */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              <span className="text-foreground text-sm font-semibold">Your Rate</span>
            </div>
            <RateUnitToggle unit={unit} onChange={handleUnitChange} />
          </div>

          {/* Oversized rate input row */}
          <div className="mt-3.5 flex flex-wrap items-center gap-3">
            <span className="text-foreground text-[32px] font-semibold">A$</span>
            <input
              type="text"
              inputMode="decimal"
              value={rateInput}
              onChange={handleRateChange}
              placeholder="0.00"
              aria-label={
                unit === 'hour' ? 'Rate per hour in dollars' : 'Rate per minute in dollars'
              }
              aria-describedby={conversionId}
              maxLength={8}
              className={cn(
                'border-primary text-foreground focus-visible:border-ring focus-visible:outline-primary border-0 border-b-[3px] bg-transparent text-center font-mono text-[48px] font-semibold tabular-nums outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid',
                unit === 'hour' ? 'w-[230px]' : 'w-[180px]'
              )}
            />
            <span className="text-muted-foreground text-base font-medium">
              {unit === 'hour' ? '/ hour' : '/ minute'}
            </span>
          </div>

          {/* Validation error */}
          {validationError && (
            <p role="alert" className="text-destructive mt-2 text-sm">
              {validationError}
            </p>
          )}

          {/* Hourly conversion */}
          <p
            id={conversionId}
            aria-live="polite"
            aria-atomic="true"
            className="text-muted-foreground mt-3 flex min-h-[22px] items-start gap-1.5 text-sm"
          >
            {wasRounded && (
              <Info className="text-primary mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span>
              <ConversionLine
                unit={unit}
                rateCents={rateCents}
                hourlyCents={hourlyCents}
                wasRounded={wasRounded}
              />
            </span>
          </p>

          <Separator className="my-6" />

          {/* What clients see */}
          <div className="border-primary/15 from-primary/5 to-primary/10 dark:from-primary/10 dark:to-primary/20 rounded-xl border bg-gradient-to-br p-5">
            <p className="text-primary text-xs font-semibold tracking-wider uppercase">
              What clients see
            </p>
            <div className="mt-2.5 flex items-baseline justify-between">
              <div>
                <span className="text-foreground text-[28px] font-semibold">
                  A${clientRatePerMin}
                </span>
                <span className="text-muted-foreground ml-1 text-sm">/ minute</span>
              </div>
              <span className="text-muted-foreground text-sm">{clientRatePerHour}/hour</span>
            </div>
            <p className="text-muted-foreground mt-2 text-xs">
              Includes Balo&apos;s {PLATFORM_PRICING.SERVICE_FEE_SHARE_LABEL} service fee
            </p>
          </div>
        </Card>
      </motion.div>

      {/* Save button */}
      <motion.div variants={itemVariants} className="mt-7 text-center">
        <Button size="lg" onClick={handleSave} disabled={isSaveDisabled}>
          {isSubmitting ? (
            'Saving...'
          ) : (
            <>
              Save rate <Check className="ml-1 h-4 w-4" />
            </>
          )}
        </Button>
      </motion.div>
    </motion.div>
  );
}
