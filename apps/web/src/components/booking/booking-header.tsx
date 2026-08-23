import { ShieldCheck } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import type { BookingFlowExpert } from './types';

export type BookingStep = 'pick_time' | 'confirm' | 'booked';

const STEPPER_STEPS: ReadonlyArray<{ key: 'pick_time' | 'confirm'; label: string }> = [
  { key: 'pick_time', label: 'Choose a time' },
  { key: 'confirm', label: 'Review & confirm' },
];

/**
 * BAL-400 — identity row + two-step stepper (design "Wrapper" composition).
 *
 * ⚠⚠ NO RATE TOKEN APPEARS ANYWHERE HERE (D4c) — this is a pure subtraction from the
 * prototype, which also never showed one in the header.
 *
 * The availability dot inlines `booking-card.tsx`'s existing "Available for new work" /
 * "Currently unavailable" treatment (there is no standalone `AvailabilityIndicator`
 * component shipped anywhere in the repo to reuse, despite the design spec's reference to
 * one — see the build report's deviations).
 */
export function BookingHeader({
  expert,
  step,
}: Readonly<{ expert: BookingFlowExpert; step: BookingStep }>): React.JSX.Element {
  return (
    <div className="border-border/60 bg-card border-b px-6 pt-6 pb-4">
      <div className="flex items-center gap-3">
        <Avatar className="h-10 w-10 rounded-xl">
          {expert.avatarUrl !== null && <AvatarImage src={expert.avatarUrl} alt="" />}
          <AvatarFallback className="bg-primary/10 text-primary rounded-xl text-sm font-semibold">
            {expert.initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-semibold">{expert.name}</span>
            {expert.verified && (
              <ShieldCheck
                className="text-success h-3.5 w-3.5 shrink-0"
                aria-label="Verified by Balo"
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground truncate text-xs">@{expert.partyLabel}</p>
            <span className="text-muted-foreground/40" aria-hidden="true">
              ·
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  expert.availableForWork
                    ? 'bg-success animate-pulse-dot'
                    : 'bg-muted-foreground/50'
                )}
                aria-hidden="true"
              />
              <span className="text-muted-foreground text-xs font-medium">
                {expert.availableForWork ? 'Available now' : 'Booking anyway'}
              </span>
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4">
        {step === 'booked' ? (
          <p className="text-foreground text-sm font-semibold">Booking confirmed</p>
        ) : (
          <ol className="flex items-center gap-2" aria-label="Booking steps">
            {STEPPER_STEPS.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2">
                {i > 0 && <span className="bg-border h-px w-4" aria-hidden="true" />}
                <span
                  className={cn(
                    'text-xs font-semibold',
                    s.key === step ? 'text-primary' : 'text-muted-foreground/60'
                  )}
                  aria-current={s.key === step ? 'step' : undefined}
                >
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
