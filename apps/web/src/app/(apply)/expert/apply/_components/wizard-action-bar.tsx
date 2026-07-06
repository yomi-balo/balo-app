'use client';

import { ArrowLeft, ArrowRight, Loader2, LogOut } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { STEP_CONFIG } from '../_actions/schemas';
import { useWizard } from './expert-application-context';

const NEXT_LABELS: Record<string, string> = {
  profile: 'Next',
  products: 'Next',
  assessment: 'Next',
  certifications: 'Next',
  'work-history': 'Next',
};

/**
 * Low-emphasis "Save & exit" affordance. Wired to `abandon()` (saves + toasts +
 * tracks APPLICATION_ABANDONED + routes to /dashboard). Visible on every step and
 * both viewports — this is what makes the abandon flow actually reachable.
 */
function SaveExitButton({ className }: Readonly<{ className?: string }>): React.JSX.Element {
  const { abandon } = useWizard();
  const [exiting, setExiting] = useState(false);

  // `abandon()` now stays on the page when the save fails, so the `finally`
  // re-enables the button. On success the component unmounts on navigation, so
  // resetting `exiting` is harmless.
  const handleClick = async (): Promise<void> => {
    setExiting(true);
    try {
      await abandon();
    } finally {
      setExiting(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      disabled={exiting}
      className={cn('text-muted-foreground', className)}
      onClick={() => void handleClick()}
    >
      {exiting ? (
        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <LogOut className="mr-1.5 h-4 w-4" aria-hidden="true" />
      )}
      Save &amp; exit
    </Button>
  );
}

export function WizardActionBar(): React.JSX.Element {
  const { currentStep, goNext, goPrevious, skipStep } = useWizard();
  const stepConfig = STEP_CONFIG[currentStep] ?? STEP_CONFIG[0];
  const isFirst = currentStep === 0;
  const isLast = currentStep === STEP_CONFIG.length - 1;
  const isSkippable = !stepConfig.required;
  const nextLabel = NEXT_LABELS[stepConfig.key] ?? 'Next';

  return (
    <>
      {/* Desktop action bar */}
      <div className="border-border mt-8 hidden items-center justify-between border-t pt-6 md:flex">
        <div className="flex items-center gap-3">
          <SaveExitButton />
          {!isFirst && (
            <Button type="button" variant="ghost" className="group" onClick={goPrevious}>
              <motion.span className="inline-flex items-center gap-1.5" whileHover={{ x: -3 }}>
                <ArrowLeft className="h-4 w-4" />
                Previous
              </motion.span>
            </Button>
          )}
        </div>

        <div className="flex items-center gap-3">
          {isSkippable && (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => void skipStep()}
            >
              Skip
            </Button>
          )}
          {!isLast && (
            <Button
              type="button"
              size="lg"
              onClick={() => void goNext()}
              className="group from-primary shadow-primary/20 hover:shadow-primary/25 bg-gradient-to-r to-violet-600 text-white shadow-md hover:shadow-lg"
            >
              <motion.span className="inline-flex items-center gap-1.5" whileHover={{ x: 3 }}>
                {nextLabel}
                <ArrowRight className="h-4 w-4" />
              </motion.span>
            </Button>
          )}
        </div>
      </div>

      {/* Mobile action bar (fixed bottom) */}
      <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 border-border pb-safe fixed inset-x-0 bottom-0 z-40 border-t px-4 py-3 backdrop-blur-sm md:hidden">
        {isSkippable && (
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground mb-2 w-full"
            onClick={() => void skipStep()}
          >
            Skip
          </Button>
        )}
        <div className="flex gap-3">
          {!isFirst && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 flex-1"
              onClick={goPrevious}
            >
              <ArrowLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
          )}
          {!isLast && (
            <Button
              type="button"
              className="from-primary min-h-11 flex-1 bg-gradient-to-r to-violet-600 text-white"
              onClick={() => void goNext()}
            >
              {nextLabel}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>
        <SaveExitButton className="mt-2 min-h-11 w-full" />
      </div>
    </>
  );
}
