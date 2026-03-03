'use client';

import { useState, useEffect, useRef, useTransition, forwardRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AnimatePresence, motion } from 'motion/react';
import { Globe, ChevronRight, ArrowLeft, Loader2 } from 'lucide-react';
import { TimezoneCombobox } from './timezone-combobox';
import { updateTimezoneAction } from '@/lib/auth/actions/update-timezone';
import { track, ONBOARDING_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';

interface TimezoneStepProps {
  onContinue: () => void;
  onBack: () => void;
  onTimezoneSelected?: (timezone: string) => void;
}

export const TimezoneStep = forwardRef<HTMLHeadingElement, TimezoneStepProps>(function TimezoneStep(
  { onContinue, onBack, onTimezoneSelected },
  ref
) {
  const [timezone, setTimezone] = useState('UTC');
  const [showSelector, setShowSelector] = useState(false);
  const [isPending, startTransition] = useTransition();
  const detectedRef = useRef<string | null>(null);

  useEffect(() => {
    track(ONBOARDING_EVENTS.STEP_VIEWED, { step: 'timezone', step_number: 2 });
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected) {
        detectedRef.current = detected;
        setTimezone(detected);
      }
    } catch {
      // Fallback to UTC is already set
    }
  }, []);

  function handleContinue(): void {
    startTransition(async () => {
      const result = await updateTimezoneAction(timezone);
      if (result.success) {
        track(ONBOARDING_EVENTS.STEP_COMPLETED, {
          step: 'timezone',
          step_number: 2,
          value: timezone,
        });
        onTimezoneSelected?.(timezone);
        onContinue();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex w-full flex-col items-center text-center">
      <h1
        ref={ref}
        tabIndex={-1}
        className="text-foreground text-xl font-semibold outline-none sm:text-2xl"
      >
        Set your timezone
      </h1>

      <p className="text-muted-foreground mt-2 text-sm">
        We use this to show you accurate availability and consultation times.
      </p>

      <Card className="mt-6 w-full p-6">
        <div className="flex items-center gap-4">
          <div className="bg-primary/10 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
            <Globe className="text-primary h-5 w-5" />
          </div>
          <div className="text-left">
            <p className="text-foreground text-sm font-medium">{timezone.replace(/_/g, ' ')}</p>
            {timezone === detectedRef.current && (
              <p className="text-muted-foreground mt-0.5 text-xs">Detected from your browser</p>
            )}
          </div>
        </div>

        {!showSelector && (
          <Button
            variant="link"
            size="sm"
            onClick={() => setShowSelector(true)}
            className="mt-2 h-auto p-0"
          >
            Change timezone
          </Button>
        )}

        <AnimatePresence>
          {showSelector && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="mt-4 overflow-hidden"
            >
              <TimezoneCombobox value={timezone} onValueChange={setTimezone} />
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      <div className="mt-8 flex flex-col items-center gap-3">
        <Button
          size="lg"
          onClick={handleContinue}
          disabled={isPending}
          className="w-full min-w-[200px] sm:w-auto"
        >
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              Continue
              <ChevronRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>

        <Button variant="ghost" size="sm" onClick={onBack} disabled={isPending}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>
    </div>
  );
});
