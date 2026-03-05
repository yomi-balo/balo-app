'use client';

import { useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ApplicationWithRelations } from '@balo/db';
import { STEP_CONFIG } from '../_actions/schemas';
import type { ReferenceData } from '../_actions/load-draft';
import { ExpertApplicationProvider, useWizard } from './expert-application-context';
import { WizardProgress } from './wizard-progress';
import { WizardActionBar } from './wizard-action-bar';
import { AutoSaveIndicator } from './auto-save-indicator';
import { StepProfile } from './step-profile';
import { StepProducts } from './step-products';
import { StepAssessment } from './step-assessment';
import { StepCertifications } from './step-certifications';
import { StepWorkHistory } from './step-work-history';
import { StepInvite } from './step-invite';
import { StepTerms } from './step-terms';

interface ExpertApplicationWizardProps {
  draft: ApplicationWithRelations | null;
  referenceData: ReferenceData;
  user: { id: string; email: string; phone: string | null };
}

function WizardContent(): React.JSX.Element {
  const { currentStep, direction } = useWizard();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Focus heading on step change
  const handleAnimationComplete = (): void => {
    headingRef.current?.focus({ preventScroll: true });
  };

  const stepKey = STEP_CONFIG[currentStep]?.key ?? 'profile';

  const STEP_COMPONENTS: Record<string, React.JSX.Element> = {
    profile: <StepProfile headingRef={headingRef} />,
    products: <StepProducts headingRef={headingRef} />,
    assessment: <StepAssessment headingRef={headingRef} />,
    certifications: <StepCertifications headingRef={headingRef} />,
    'work-history': <StepWorkHistory headingRef={headingRef} />,
    invite: <StepInvite headingRef={headingRef} />,
    terms: <StepTerms headingRef={headingRef} />,
  };

  return (
    <div className="-m-6 min-h-screen bg-[#F8FAFB] lg:-m-8">
      <div className="mx-auto max-w-4xl px-4 py-8 pb-20 md:pb-8 [&_[data-slot=checkbox]]:bg-white [&_[data-slot=input]]:bg-white [&_[data-slot=select-trigger]]:bg-white [&_textarea]:bg-white">
        <WizardProgress />

        <div className="mb-4 flex justify-end">
          <AutoSaveIndicator />
        </div>

        <div aria-live="polite">
          <AnimatePresence mode="wait">
            <motion.div
              key={stepKey}
              initial={{
                opacity: 0,
                x: direction === 'forward' ? 40 : -40,
              }}
              animate={{ opacity: 1, x: 0 }}
              exit={{
                opacity: 0,
                x: direction === 'forward' ? -40 : 40,
              }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
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
