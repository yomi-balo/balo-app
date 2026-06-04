'use client';

import { motion, useReducedMotion } from 'motion/react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PillOption {
  /** The value written to filter state (id or sentinel key). */
  value: string;
  label: string;
}

interface PillRowProps {
  options: ReadonlyArray<PillOption>;
  /** Selected values; for single-select rows this holds at most one value. */
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  /** Accessible group label for the row. */
  ariaLabel: string;
}

/** Generic rounded-pill toggle row, used for support types, timeframe, languages. */
export function PillRow({
  options,
  selected,
  onToggle,
  ariaLabel,
}: Readonly<PillRowProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">{ariaLabel}</legend>
      {options.map((option) => {
        const active = selected.has(option.value);
        return (
          <motion.button
            key={option.value}
            type="button"
            onClick={() => onToggle(option.value)}
            aria-pressed={active}
            whileTap={reduce ? undefined : { scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 600, damping: 30 }}
            className={cn(
              'focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13px] transition-colors focus-visible:ring-2 focus-visible:outline-none',
              active
                ? 'border-primary/40 bg-primary/10 text-primary font-semibold'
                : 'border-border bg-card text-foreground hover:bg-muted font-medium'
            )}
          >
            {active && <Check className="text-primary h-3 w-3 shrink-0" aria-hidden />}
            {option.label}
          </motion.button>
        );
      })}
    </fieldset>
  );
}
