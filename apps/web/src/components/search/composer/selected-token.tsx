'use client';

import { motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';

interface SelectedTokenProps {
  label: string;
  onRemove: () => void;
}

/**
 * Removable selected-product token — light primary fill with an × button.
 * Layout-animated in/out (gated on reduced-motion) inside an `AnimatePresence`.
 */
export function SelectedToken({
  label,
  onRemove,
}: Readonly<SelectedTokenProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  return (
    <motion.span
      layout
      initial={reduce ? false : { opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      className="text-primary border-primary/40 bg-card inline-flex items-center gap-2 rounded-lg border py-1.5 pr-2 pl-3 text-[13px] font-medium"
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="bg-primary/10 hover:bg-primary hover:text-primary-foreground text-primary focus-visible:ring-ring flex h-[18px] w-[18px] items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="h-2.5 w-2.5" aria-hidden />
      </button>
    </motion.span>
  );
}
