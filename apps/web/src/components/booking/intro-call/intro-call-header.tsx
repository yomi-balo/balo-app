import { InitialsAvatar } from '@/components/balo/conversation/initials-avatar';
import { BookingStepper, type BookingStepperStep } from '../booking-header';

export type IntroCallStep = 'pick_time' | 'confirm' | 'booked';

const STEPS: readonly BookingStepperStep[] = [
  { key: 'pick_time', label: 'Choose a time' },
  { key: 'confirm', label: 'Confirm' },
];

/**
 * BAL-283 — the intro-call dialog's identity row + stepper (plan §12.2). NOT `BookingHeader`
 * fed a fabricated `BookingFlowExpert`: that would require `avatarUrl` / `verified` /
 * `availableForWork`, none of which the conversation view-model carries — fabricating them
 * would render a missing verified badge and a party label that is actually the person's name,
 * violating the prospective-attribution copy rule for agency-based experts. Reuses the
 * EXTRACTED `BookingStepper` with its own step 2 label ("Confirm", not "Review & confirm" —
 * there's nothing to review, no case draft, no billing).
 */
export function IntroCallHeader({
  expertName,
  expertInitials,
  step,
}: Readonly<{
  expertName: string;
  expertInitials: string;
  step: IntroCallStep;
}>): React.JSX.Element {
  return (
    <div className="border-border/60 bg-card border-b px-6 pt-6 pb-4">
      <div className="flex items-center gap-3">
        <InitialsAvatar initials={expertInitials} size="md" />
        <span className="text-foreground truncate text-sm font-semibold">{expertName}</span>
      </div>
      <div className="mt-4">
        {step === 'booked' ? (
          <p className="text-foreground text-sm font-semibold">Booking confirmed</p>
        ) : (
          <BookingStepper steps={STEPS} step={step} />
        )}
      </div>
    </div>
  );
}
