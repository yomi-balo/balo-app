'use client';

import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useWizard } from './expert-application-context';

const STATES = {
  idle: null,
  saving: {
    icon: Loader2,
    iconClassName: 'h-3 w-3 animate-spin text-muted-foreground',
    text: 'Saving...',
    textClassName: 'text-xs text-muted-foreground',
  },
  saved: {
    icon: Check,
    iconClassName: 'h-3 w-3 text-success',
    text: 'Saved',
    textClassName: 'text-xs text-muted-foreground',
  },
  error: {
    icon: AlertCircle,
    iconClassName: 'h-3 w-3 text-destructive',
    text: 'Unsaved changes',
    textClassName: 'text-xs text-destructive',
  },
} as const;

export function AutoSaveIndicator(): React.JSX.Element {
  const { autoSaveState } = useWizard();
  const config = STATES[autoSaveState];

  return (
    <AnimatePresence mode="wait">
      {config && (
        <motion.div
          key={autoSaveState}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center gap-1.5"
        >
          <config.icon className={config.iconClassName} aria-hidden="true" />
          <span className={config.textClassName}>{config.text}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
