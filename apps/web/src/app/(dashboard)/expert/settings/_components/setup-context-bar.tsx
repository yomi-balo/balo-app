'use client';

import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { CHECKLIST_ITEMS } from '@/lib/constants/expert-checklist';
import { cn } from '@/lib/utils';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

interface SetupContextBarProps {
  activeSetupStep: string;
  checklistStatus: ChecklistStatus;
}

export function SetupContextBar({
  activeSetupStep,
  checklistStatus,
}: SetupContextBarProps): React.JSX.Element {
  const router = useRouter();

  const stepIndex = CHECKLIST_ITEMS.findIndex((item) => item.key === activeSetupStep);
  const matchedItem = stepIndex >= 0 ? CHECKLIST_ITEMS[stepIndex] : undefined;
  const stepLabel = matchedItem?.label ?? activeSetupStep;
  const stepNumber = stepIndex >= 0 ? stepIndex + 1 : 1;

  return (
    <motion.div
      initial={{ y: -8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="from-primary/5 dark:from-primary/10 mb-6 rounded-xl bg-gradient-to-r to-purple-500/5 p-3 px-5 dark:to-purple-500/10"
      style={{ border: '1px solid rgba(124,58,237,0.15)' }}
    >
      <div className="flex items-center gap-4">
        {/* Back link */}
        <button
          onClick={() => router.push('/dashboard')}
          className="text-primary flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-80"
        >
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </button>

        {/* Divider */}
        <div className="h-5 w-px" style={{ backgroundColor: 'rgba(124,58,237,0.2)' }} />

        {/* Step info */}
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5" style={{ color: '#7C3AED' }} />
          <span className="text-sm font-semibold" style={{ color: '#7C3AED' }}>
            Getting Started
          </span>
          <span style={{ color: '#7C3AED' }}>&middot;</span>
          <span className="text-muted-foreground text-sm">
            Step {stepNumber} of 5 — {stepLabel}
          </span>
        </div>

        {/* Progress dots -- hidden on mobile */}
        <div className="hidden items-center gap-1.5 sm:ml-auto sm:flex">
          {CHECKLIST_ITEMS.map((item) => {
            const isComplete =
              checklistStatus.items[item.key as keyof typeof checklistStatus.items];
            const isCurrent = item.key === activeSetupStep;

            return (
              <div
                key={item.key}
                className={cn('h-2 w-2 rounded-full', !isComplete && !isCurrent && 'bg-border')}
                style={{
                  ...(isComplete
                    ? { background: 'linear-gradient(135deg, #2563EB, #7C3AED)' }
                    : isCurrent
                      ? { background: '#7C3AED', boxShadow: '0 0 0 3px rgba(124,58,237,0.2)' }
                      : {}),
                }}
              />
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
