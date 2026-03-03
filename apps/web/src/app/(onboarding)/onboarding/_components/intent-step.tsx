'use client';

import { useState, useTransition, forwardRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { motion } from 'motion/react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { completeOnboardingAction } from '@/lib/auth/actions/complete-onboarding';
import { track, ONBOARDING_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';
import { FindExpertIllustration, BecomeExpertIllustration } from './illustrations';
import { cn } from '@/lib/utils';

interface IntentStepProps {
  onBack: () => void;
  timezone?: string | null;
  stepNumber?: number;
}

type Intent = 'client' | 'expert';

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

export const IntentStep = forwardRef<HTMLHeadingElement, IntentStepProps>(function IntentStep(
  { onBack, timezone, stepNumber = 3 },
  ref
) {
  const router = useRouter();
  const [selectedIntent, setSelectedIntent] = useState<Intent | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    track(ONBOARDING_EVENTS.STEP_VIEWED, { step: 'intent', step_number: stepNumber });
  }, [stepNumber]);

  function handleSelect(intent: Intent): void {
    if (isPending || selectedIntent !== null) return;

    setSelectedIntent(intent);
    startTransition(async () => {
      const result = await completeOnboardingAction(intent);
      if (result.success) {
        track(ONBOARDING_EVENTS.STEP_COMPLETED, {
          step: 'intent',
          step_number: stepNumber,
          value: intent,
        });
        track(ONBOARDING_EVENTS.COMPLETED, {
          intent,
          timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        router.push(result.data?.redirectTo ?? '/dashboard');
      } else {
        toast.error(result.error);
        setSelectedIntent(null);
      }
    });
  }

  const isDisabled = isPending || selectedIntent !== null;

  return (
    <div className="flex w-full flex-col items-center text-center">
      <h1
        ref={ref}
        tabIndex={-1}
        className="text-foreground text-xl font-semibold outline-none sm:text-2xl"
      >
        What brings you to Balo?
      </h1>

      <p className="text-muted-foreground mt-2 text-sm">
        Choose how you&apos;d like to get started. You can always switch later.
      </p>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="mt-8 grid w-full grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6"
      >
        {/* Find an Expert */}
        <motion.div
          variants={item}
          whileHover={isDisabled ? undefined : { y: -4 }}
          whileTap={isDisabled ? undefined : { scale: 0.98 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <Card
            role="button"
            tabIndex={isDisabled ? -1 : 0}
            aria-label="Find an Expert — Get matched with top Salesforce consultants for your business"
            onClick={() => handleSelect('client')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleSelect('client');
              }
            }}
            className={cn(
              'dark:hover:shadow-primary/5 cursor-pointer overflow-hidden transition-shadow duration-200 hover:shadow-lg',
              isDisabled && selectedIntent !== 'client' && 'pointer-events-none opacity-50'
            )}
          >
            <div className="h-[100px] sm:h-[120px]">
              <FindExpertIllustration />
            </div>
            <div className="p-6">
              <h3 className="text-foreground text-lg font-semibold">Find an Expert</h3>
              <p className="text-muted-foreground mt-2 text-sm">
                Get matched with top Salesforce consultants for your business.
              </p>
              <Button
                variant="default"
                size="lg"
                className="mt-4 w-full"
                disabled={isDisabled}
                tabIndex={-1}
              >
                {selectedIntent === 'client' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Setting up...
                  </>
                ) : (
                  'Get Started'
                )}
              </Button>
            </div>
          </Card>
        </motion.div>

        {/* Become an Expert */}
        <motion.div
          variants={item}
          whileHover={isDisabled ? undefined : { y: -4 }}
          whileTap={isDisabled ? undefined : { scale: 0.98 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <Card
            role="button"
            tabIndex={isDisabled ? -1 : 0}
            aria-label="Become an Expert — Apply to join our consultant network and grow your practice"
            onClick={() => handleSelect('expert')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleSelect('expert');
              }
            }}
            className={cn(
              'dark:hover:shadow-primary/5 cursor-pointer overflow-hidden transition-shadow duration-200 hover:shadow-lg',
              isDisabled && selectedIntent !== 'expert' && 'pointer-events-none opacity-50'
            )}
          >
            <div className="h-[100px] sm:h-[120px]">
              <BecomeExpertIllustration />
            </div>
            <div className="p-6">
              <h3 className="text-foreground text-lg font-semibold">Become an Expert</h3>
              <p className="text-muted-foreground mt-2 text-sm">
                Apply to join our consultant network and grow your practice.
              </p>
              <Button
                variant="outline"
                size="lg"
                className="mt-4 w-full"
                disabled={isDisabled}
                tabIndex={-1}
              >
                {selectedIntent === 'expert' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Setting up...
                  </>
                ) : (
                  'Apply Now'
                )}
              </Button>
            </div>
          </Card>
        </motion.div>
      </motion.div>

      <Button variant="ghost" size="sm" onClick={onBack} disabled={isDisabled} className="mt-6">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>
    </div>
  );
});
