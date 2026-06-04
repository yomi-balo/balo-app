'use client';

import { type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ProductChipProps {
  /** Display label — may include highlight markup when searching. */
  label: ReactNode;
  /** Accessible name (plain text — `label` may be a highlighted node). */
  name: string;
  selected: boolean;
  onToggle: () => void;
}

/**
 * Selectable product option chip. Light-blue selected state (NOT a solid fill,
 * per design) and a reduced-motion-gated tap-scale.
 */
export function ProductChip({
  label,
  name,
  selected,
  onToggle,
}: Readonly<ProductChipProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={name}
      whileTap={reduce ? undefined : { scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      className={cn(
        'focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-[10px] border px-3.5 py-2 text-[13.5px] whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none',
        selected
          ? 'border-primary/40 bg-primary/10 text-primary font-semibold'
          : 'border-border bg-card text-foreground hover:bg-muted font-medium'
      )}
    >
      {selected && <Check className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />}
      <span>{label}</span>
    </motion.button>
  );
}
