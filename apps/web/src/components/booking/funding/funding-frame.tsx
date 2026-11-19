'use client';

import { useEffect, useId, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ChevronLeft, Loader2, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BookingFundingMethodProperty, CreditSurfaceProperty } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { caseSavedCopy, type CaseSavedNote } from '../booking-error-panels';
import { fundingCopyFor, isCallFunding, type FundingContext } from './funding-copy';
import type { RefusedFundingView } from './funding-disposition';

export const CTA_GRADIENT = 'from-primary bg-gradient-to-br to-violet-600 text-white';

function trackNothing(): void {}

/**
 * The tracker for the `BOOKING_EVENTS.FUNDING_*` family. A call funds through this same block but
 * reports through the call funding-gate events, so in the `call` context these events are not sent.
 */
export function bookingFundingTracker(context: FundingContext): typeof track {
  return isCallFunding(context) ? trackNothing : track;
}

/**
 * The `surface` the credit events (`CREDIT_EVENTS.*`) carry: `call` for funding a call (placed or
 * answered), `booking` for a booking. The credit events always fire; only their surface differs.
 */
export function creditSurfaceFor(context: FundingContext): CreditSurfaceProperty {
  return isCallFunding(context) ? 'call' : 'booking';
}

/** Tracks whether the component is still mounted, for state updates after an awaited booking. */
export function useMountedRef(): React.RefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

interface FundingSectionProps {
  readonly view: RefusedFundingView;
  readonly caseSaved: CaseSavedNote | null;
  readonly draftKept: boolean;
  /** The selected method, for the header band; the top-up band is the default. */
  readonly method?: BookingFundingMethodProperty;
  /** Whose wording the band uses; the booking's by default. */
  readonly context?: FundingContext;
  readonly children?: React.ReactNode;
}

/** The framed block: a header band (icon, heading, body) and, for a manager, the controls below. */
export function FundingSection({
  view,
  caseSaved,
  draftKept,
  method,
  context = 'booking',
  children,
}: Readonly<FundingSectionProps>) {
  const headingId = useId();
  const reduceMotion = useReducedMotion();
  const copy = fundingCopyFor(context).blockCopy(view, draftKept, method ?? 'topup');
  return (
    <motion.section
      aria-labelledby={headingId}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="border-primary/20 bg-card overflow-hidden rounded-[14px] border"
    >
      <div
        className={cn(
          'bg-primary/5 flex items-start gap-3 px-[18px] py-4',
          children !== undefined && 'border-border border-b'
        )}
      >
        <span className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-[10px]">
          <Wallet className="text-primary size-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="text-foreground text-[15px] leading-snug font-semibold">
            {copy.heading}
          </h3>
          <p className="text-muted-foreground mt-1 text-[13.5px] leading-relaxed">{copy.body}</p>
          {caseSaved !== null && (
            <p className="text-muted-foreground mt-1.5 text-[13.5px] leading-relaxed">
              {caseSavedCopy(caseSaved)}
            </p>
          )}
        </div>
      </div>
      {children}
    </motion.section>
  );
}

interface FundingFooterProps {
  readonly onBack: () => void;
  readonly backDisabled: boolean;
  /** The primary-action slot, focusable so focus survives the action being swapped. */
  readonly slotRef?: React.Ref<HTMLDivElement>;
  readonly children: React.ReactNode;
}

/** `[Back] [primary action]`, bottom-aligned so an error above the action does not skew Back. */
export function FundingFooter({
  onBack,
  backDisabled,
  slotRef,
  children,
}: Readonly<FundingFooterProps>) {
  return (
    <div className="flex items-end gap-2">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={onBack}
        disabled={backDisabled}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        Back
      </Button>
      <div
        ref={slotRef}
        tabIndex={slotRef === undefined ? undefined : -1}
        className="min-w-0 flex-1 focus:outline-none"
      >
        {children}
      </div>
    </div>
  );
}

export function BusyButton({ label }: Readonly<{ label: string }>) {
  return (
    <Button
      type="button"
      size="lg"
      disabled
      aria-busy="true"
      className={cn('min-h-11 w-full', CTA_GRADIENT)}
    >
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {label}
    </Button>
  );
}
