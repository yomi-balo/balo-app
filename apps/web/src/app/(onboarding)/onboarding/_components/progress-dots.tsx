'use client';

import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

interface ProgressDotsProps {
  current: number;
  total: number;
}

export function ProgressDots({ current, total }: ProgressDotsProps): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-center gap-2"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label="Onboarding progress"
    >
      {Array.from({ length: total }).map((_, i) => {
        const step = i + 1;
        const isActive = step === current;
        const isCompleted = step < current;

        return (
          <motion.div
            key={i}
            layout
            className={cn(
              'h-2 rounded-full',
              isActive && 'bg-primary',
              isCompleted && 'bg-primary/40',
              !isActive && !isCompleted && 'bg-muted-foreground/20'
            )}
            animate={{ width: isActive ? 24 : 8 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            aria-label={`Step ${step} of ${total}${isActive ? ' (current)' : isCompleted ? ' (completed)' : ''}`}
          />
        );
      })}
    </div>
  );
}
