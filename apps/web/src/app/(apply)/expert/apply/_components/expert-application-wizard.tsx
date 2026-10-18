'use client';

import { useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ApplicationWithRelations } from '@balo/db';
import { STEP_CONFIG } from '../_actions/schemas';
import type { ReferenceData } from '../_actions/load-draft';
import { ExpertApplicationProvider, useWizard } from './expert-application-context';
import { WizardProgress } from './wizard-progress';
import { WizardActionBar } from './wizard-action-bar';
import { AutoSaveIndicator } from './auto-save-indicator';
import { StepProfile } from './step-profile';
import { StepAgency } from './step-agency';
import { StepProducts } from './step-products';
import { StepAssessment } from './step-assessment';
import { StepCertifications } from './step-certifications';
import { StepWorkHistory } from './step-work-history';
import { StepTerms } from './step-terms';

interface ExpertApplicationWizardProps {
  draft: ApplicationWithRelations | null;
  referenceData: ReferenceData;
  /** `null` for an anonymous visitor (BAL-502 §22). `user === null` IS the anonymous
   * signal — the wizard renders fully and is fully fillable either way. FIX round
   * (smaller item) — `{ id }` only: no `_components/` consumer reads `.email`, so
   * the visitor's own email address doesn't need to ship into this client payload. */
  user: { id: string } | null;
}

// Step-slide variants with a reduced-motion guard. Pure + exported so the
// reduced-motion branches are unit-testable without mounting the wizard.
// `initial` / `exit` carry the slide for EVERY viewer: `useReducedMotion()` is null on the server
// and true on the client, so a reduced-motion `initial.x` of 0 would hydrate to a different
// inline transform. Reduced motion zeroes the x transition instead, keeping the opacity fade.
export function stepSlideVariants(
  direction: 'forward' | 'backward',
  reduce: boolean
): {
  initial: { opacity: number; x: number };
  animate: { opacity: number; x: number };
  exit: { opacity: number; x: number };
  transition: { duration: number; ease: 'easeOut'; x?: { duration: number } };
} {
  const slide = direction === 'forward' ? 40 : -40; // no nested ternary
  return {
    initial: { opacity: 0, x: slide },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -slide },
    transition: reduce
      ? { duration: 0.15, ease: 'easeOut', x: { duration: 0 } }
      : { duration: 0.3, ease: 'easeOut' },
  };
}

function WizardContent(): React.JSX.Element {
  const { currentStep, direction } = useWizard();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reduce = useReducedMotion();
  const variants = stepSlideVariants(direction, reduce ?? false);

  // Focus heading on step change
  const handleAnimationComplete = (): void => {
    headingRef.current?.focus({ preventScroll: true });
  };

  const stepKey = STEP_CONFIG[currentStep]?.key ?? 'profile';

  const STEP_COMPONENTS: Record<string, React.JSX.Element> = {
    profile: <StepProfile headingRef={headingRef} />,
    agency: <StepAgency headingRef={headingRef} />,
    products: <StepProducts headingRef={headingRef} />,
    assessment: <StepAssessment headingRef={headingRef} />,
    certifications: <StepCertifications headingRef={headingRef} />,
    'work-history': <StepWorkHistory headingRef={headingRef} />,
    terms: <StepTerms headingRef={headingRef} />,
  };

  return (
    <div>
      <div data-wizard-inputs className="mx-auto max-w-4xl">
        <WizardProgress />

        <div className="mb-4 flex justify-end">
          <AutoSaveIndicator />
        </div>

        <div aria-live="polite">
          <AnimatePresence mode="wait">
            <motion.div
              key={stepKey}
              initial={variants.initial}
              animate={variants.animate}
              exit={variants.exit}
              transition={variants.transition}
              onAnimationComplete={handleAnimationComplete}
            >
              {STEP_COMPONENTS[stepKey]}
            </motion.div>
          </AnimatePresence>
        </div>

        <WizardActionBar />
      </div>
    </div>
  );
}

export function ExpertApplicationWizard({
  draft,
  referenceData,
  user,
}: Readonly<ExpertApplicationWizardProps>): React.JSX.Element {
  return (
    <ExpertApplicationProvider draft={draft} referenceData={referenceData} user={user}>
      <WizardContent />
    </ExpertApplicationProvider>
  );
}
