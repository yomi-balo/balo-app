'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, DollarSign, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { IconBadge } from '@/components/balo/icon-badge';
import { track, EXPERT_RATE_EVENTS } from '@/lib/analytics';
import { PLATFORM_PRICING } from '@/lib/constants/platform';
import {
  centsToDollars,
  dollarsToCents,
  formatCurrency,
  calculateClientRate,
  perMinuteToPerHour,
} from '@/lib/utils/currency';
import { saveRateAction } from '../_actions/save-rate';

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

export function RateTab({ initialRateCents }: RateTabProps): React.JSX.Element {
  const [rateInput, setRateInput] = useState<string>(
    initialRateCents && initialRateCents > 0 ? centsToDollars(initialRateCents).toFixed(2) : ''
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  // All derived — no useEffect, no extra state
  const rateDollars = parseFloat(rateInput) || 0;
  const rateCents = dollarsToCents(rateDollars);
  const clientRateCents = calculateClientRate(rateCents);
  const hourlyExpertCents = perMinuteToPerHour(rateCents);
  const hourlyClientCents = perMinuteToPerHour(clientRateCents);

  const validationError =
    rateDollars > PLATFORM_PRICING.MAX_RATE_DOLLARS
      ? `Max rate is ${PLATFORM_PRICING.CURRENCY_SYMBOL}${PLATFORM_PRICING.MAX_RATE_DOLLARS}/min`
      : rateInput !== '' && rateCents <= 0
        ? 'Rate must be greater than zero'
        : null;

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

  async function handleSave(): Promise<void> {
    if (isSaveDisabled) return;
    setIsSubmitting(true);
    try {
      const result = await saveRateAction({ ratePerMinuteCents: rateCents });
      if (result.success) {
        toast.success(
          `Rate saved — ${PLATFORM_PRICING.CURRENCY_SYMBOL}${rateDollars.toFixed(2)}/min`
        );
        track(EXPERT_RATE_EVENTS.RATE_SAVED, {
          rate_per_minute_cents: rateCents,
          is_initial_setup: !initialRateCents || initialRateCents === 0,
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
  const hourlyExpert = formatCurrency(hourlyExpertCents);
  const clientRatePerMin = centsToDollars(clientRateCents).toFixed(2);
  const clientRatePerHour = formatCurrency(hourlyClientCents);
  const earnings30min = formatCurrency(rateCents * 30);
  const clientPays30min = formatCurrency(clientRateCents * 30);

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-[620px]"
    >
      {/* Hero header */}
      <motion.div variants={itemVariants} className="mb-9 text-center">
        <IconBadge
          icon={DollarSign}
          color="#059669"
          size={52}
          iconSize={24}
          className="mx-auto mb-4"
        />
        <h1 className="text-foreground text-2xl font-semibold">Set Your Rate</h1>
        <p className="text-muted-foreground mx-auto mt-2 max-w-[440px] text-sm leading-relaxed">
          This is your take-home amount per minute. Clients see a higher rate that includes
          Balo&apos;s service fee.
        </p>
      </motion.div>

      {/* Rate input card */}
      <motion.div variants={itemVariants}>
        <Card className="p-8">
          {/* Section label */}
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-emerald-600" />
            <span className="text-foreground text-sm font-semibold">Your Rate</span>
          </div>

          {/* Oversized rate input row */}
          <div className="mt-2 flex items-center gap-3">
            <span className="text-foreground text-[32px] font-semibold">A$</span>
            <input
              type="text"
              inputMode="decimal"
              value={rateInput}
              onChange={handleRateChange}
              placeholder="0.00"
              aria-label="Rate per minute in dollars"
              className="border-primary text-foreground focus-visible:border-ring w-[180px] border-0 border-b-[3px] bg-transparent text-center font-mono text-[48px] font-semibold tabular-nums outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <span className="text-muted-foreground text-base font-medium">/ minute</span>
          </div>

          {/* Validation error */}
          {validationError && <p className="text-destructive mt-2 text-sm">{validationError}</p>}

          {/* Hourly conversion */}
          <p className="text-muted-foreground mt-3 text-sm">
            That&apos;s <span className="text-foreground font-semibold">{hourlyExpert}/hour</span>{' '}
            take-home
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
              Includes Balo&apos;s {PLATFORM_PRICING.MARKUP_LABEL} service fee
            </p>
          </div>
        </Card>
      </motion.div>

      {/* Quick math box */}
      <motion.div variants={itemVariants}>
        <div className="border-border bg-muted/50 mt-5 flex items-start gap-2.5 rounded-xl border p-4">
          <Zap className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            <span className="text-foreground font-semibold">Quick math:</span> A 30-minute
            consultation earns you{' '}
            <span className="text-success font-semibold">{earnings30min}</span>. The client pays{' '}
            {clientPays30min}.
          </p>
        </div>
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
