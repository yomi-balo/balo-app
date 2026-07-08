'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { NameStep } from './name-step';
import { WelcomeStep } from './welcome-step';
import { TimezoneStep } from './timezone-step';
import { IntentStep } from './intent-step';
import { CompanyStep } from './company-step';
import { ProgressDots } from './progress-dots';
import { cn } from '@/lib/utils';
import type { AuthMethodSignal } from '@/lib/auth/auth-method';

interface OnboardingWizardProps {
  firstName: string | null;
  authMethod?: AuthMethodSignal;
}

const variants = {
  enter: (dir: number) => ({ x: dir > 0 ? 80 : -80, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -80 : 80, opacity: 0 }),
};

export function OnboardingWizard({
  firstName,
  authMethod,
}: OnboardingWizardProps): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  const needsNameStep = firstName === null;
  // BAL-350: base + 1 for the new client-only company step (the client terminal).
  // Experts redirect away at Intent so they never reach the final dot.
  const totalSteps = needsNameStep ? 5 : 4;

  function clampStep(step: number): number {
    return Math.max(1, Math.min(totalSteps, step));
  }

  const stepFromUrl = parseInt(searchParams.get('step') ?? '1', 10);
  const [currentStep, setCurrentStep] = useState(
    Number.isNaN(stepFromUrl) ? 1 : clampStep(stepFromUrl)
  );
  const [direction, setDirection] = useState(1);
  const [selectedTimezone, setSelectedTimezone] = useState<string | null>(null);
  const [collectedName, setCollectedName] = useState<string | null>(firstName);

  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      headingRef.current?.focus();
    }, 350);
    return () => clearTimeout(timer);
  }, [currentStep]);

  const goToStep = useCallback(
    (step: number, dir: number) => {
      setDirection(dir);
      setCurrentStep(step);
      router.replace(`/onboarding?step=${step}`, { scroll: false });
    },
    [router]
  );

  const goForward = useCallback(() => {
    if (currentStep < totalSteps) {
      goToStep(currentStep + 1, 1);
    }
  }, [currentStep, totalSteps, goToStep]);

  const goBack = useCallback(() => {
    if (currentStep > 1) {
      goToStep(currentStep - 1, -1);
    }
  }, [currentStep, goToStep]);

  const handleNameComplete = useCallback(
    (data: { firstName: string; lastName: string }) => {
      setCollectedName(data.firstName);
      goForward();
    },
    [goForward]
  );

  function renderStep(): React.JSX.Element {
    if (needsNameStep) {
      switch (currentStep) {
        case 1:
          return <NameStep ref={headingRef} onContinue={handleNameComplete} />;
        case 2:
          return (
            <WelcomeStep
              ref={headingRef}
              firstName={collectedName}
              onContinue={goForward}
              stepNumber={2}
            />
          );
        case 3:
          return (
            <TimezoneStep
              ref={headingRef}
              onContinue={goForward}
              onBack={goBack}
              onTimezoneSelected={setSelectedTimezone}
              stepNumber={3}
            />
          );
        case 4:
          return (
            <IntentStep
              ref={headingRef}
              onBack={goBack}
              onClientContinue={goForward}
              timezone={selectedTimezone}
              stepNumber={4}
            />
          );
        case 5:
          return (
            <CompanyStep
              ref={headingRef}
              authMethod={authMethod}
              timezone={selectedTimezone}
              onBack={goBack}
              stepNumber={5}
            />
          );
        default:
          return <NameStep ref={headingRef} onContinue={handleNameComplete} />;
      }
    }

    // Standard flow (no name step): Welcome → Timezone → Intent → Company
    switch (currentStep) {
      case 1:
        return <WelcomeStep ref={headingRef} firstName={firstName} onContinue={goForward} />;
      case 2:
        return (
          <TimezoneStep
            ref={headingRef}
            onContinue={goForward}
            onBack={goBack}
            onTimezoneSelected={setSelectedTimezone}
          />
        );
      case 3:
        return (
          <IntentStep
            ref={headingRef}
            onBack={goBack}
            onClientContinue={goForward}
            timezone={selectedTimezone}
          />
        );
      case 4:
        return (
          <CompanyStep
            ref={headingRef}
            authMethod={authMethod}
            timezone={selectedTimezone}
            onBack={goBack}
            stepNumber={4}
          />
        );
      default:
        return <WelcomeStep ref={headingRef} firstName={firstName} onContinue={goForward} />;
    }
  }

  // Determine if the current step is the intent step (full-width for card grid)
  const isIntentStep = needsNameStep ? currentStep === 4 : currentStep === 3;

  return (
    <div className="flex w-full flex-col items-center">
      <div
        className={cn('w-full', isIntentStep ? 'max-w-2xl' : 'max-w-lg')}
        aria-live="polite"
        aria-atomic="true"
      >
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={currentStep}
            custom={direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            {renderStep()}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-8">
        <ProgressDots current={currentStep} total={totalSteps} />
      </div>
    </div>
  );
}
