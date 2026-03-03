'use client';

import { forwardRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronRight } from 'lucide-react';
import { track, ONBOARDING_EVENTS } from '@/lib/analytics';

interface WelcomeStepProps {
  firstName: string | null;
  onContinue: () => void;
  stepNumber?: number;
}

export const WelcomeStep = forwardRef<HTMLHeadingElement, WelcomeStepProps>(function WelcomeStep(
  { firstName, onContinue, stepNumber = 1 },
  ref
) {
  useEffect(() => {
    track(ONBOARDING_EVENTS.STEP_VIEWED, { step: 'welcome', step_number: stepNumber });
  }, [stepNumber]);

  function handleContinue(): void {
    track(ONBOARDING_EVENTS.STEP_COMPLETED, { step: 'welcome', step_number: stepNumber });
    onContinue();
  }

  const heading = firstName ? `Welcome to Balo, ${firstName}!` : 'Welcome to Balo!';

  return (
    <div className="flex flex-col items-center text-center">
      <h1
        ref={ref}
        tabIndex={-1}
        className="text-foreground text-2xl font-semibold outline-none sm:text-3xl"
      >
        {heading}
      </h1>

      <p className="text-muted-foreground mt-4 max-w-md text-base leading-relaxed">
        Your gateway to expert technology consultants. Whether you need help with Salesforce, or
        you&apos;re an expert ready to grow your practice — you&apos;re in the right place.
      </p>

      <Button size="lg" onClick={handleContinue} className="mt-8 w-full min-w-[200px] sm:w-auto">
        Get Started
        <ChevronRight className="ml-2 h-4 w-4" />
      </Button>

      <p className="text-muted-foreground mt-3 text-xs">Takes about 30 seconds</p>
    </div>
  );
});
