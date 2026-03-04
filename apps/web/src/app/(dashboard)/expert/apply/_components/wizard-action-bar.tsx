'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { STEP_CONFIG } from '../_actions/schemas';
import { useWizard } from './expert-application-context';

const NEXT_LABELS: Record<string, string> = {
  profile: 'Next: Products',
  products: 'Next: Self-Assessment',
  assessment: 'Next: Certifications',
  certifications: 'Next: Work History',
  'work-history': 'Next: Invite Experts',
  invite: 'Next: Terms',
};

export function WizardActionBar(): React.JSX.Element {
  const { currentStep, goNext, goPrevious, skipStep, abandon } = useWizard();
  const stepConfig = STEP_CONFIG[currentStep]!;
  const isFirst = currentStep === 0;
  const isLast = currentStep === STEP_CONFIG.length - 1;
  const isSkippable = !stepConfig.required;
  const nextLabel = NEXT_LABELS[stepConfig.key] ?? 'Next';

  return (
    <>
      {/* Desktop action bar */}
      <div className="border-border mt-8 hidden items-center justify-between border-t pt-6 md:flex">
        <div className="flex items-center gap-3">
          {!isFirst && (
            <Button type="button" variant="ghost" onClick={goPrevious} className="group">
              <motion.span className="inline-flex items-center gap-1" whileHover={{ x: -3 }}>
                <ChevronLeft className="h-4 w-4" />
                Previous
              </motion.span>
            </Button>
          )}
          {isFirst && (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => void abandon()}
            >
              Save &amp; continue later
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
              Skip this step
            </Button>
          )}
          {!isLast && (
            <Button type="button" size="lg" onClick={() => void goNext()} className="group">
              <motion.span className="inline-flex items-center gap-1" whileHover={{ x: 3 }}>
                {nextLabel}
                <ChevronRight className="h-4 w-4" />
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
            Skip this step
          </Button>
        )}
        <div className="flex gap-3">
          {!isFirst && (
            <Button type="button" variant="outline" className="flex-1" onClick={goPrevious}>
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
          )}
          {isFirst && (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground flex-1"
              onClick={() => void abandon()}
            >
              Save for later
            </Button>
          )}
          {!isLast && (
            <Button type="button" className="flex-1" onClick={() => void goNext()}>
              {nextLabel}
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
