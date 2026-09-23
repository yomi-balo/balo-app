'use client';

import { Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';

interface ChipOption {
  id: string;
  label: string;
}

type ChipSize = 'default' | 'compact';

interface ChipPickerProps {
  options: ChipOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  className?: string;
  /** `compact`: a lighter chip for dense settings cards — 12.5px, 1px border, soft tint. */
  size?: ChipSize;
}

const CHIP_SIZE_CLASSES: Record<
  ChipSize,
  { readonly base: string; readonly selected: string; readonly unselected: string }
> = {
  default: {
    base: 'h-8 gap-[5px] rounded-[20px] border-[1.5px] px-3 text-[13px] font-medium',
    selected:
      'border-primary bg-primary/[0.08] text-primary hover:border-primary/80 hover:bg-primary/[0.12] font-semibold',
    unselected:
      'border-border bg-background text-muted-foreground hover:border-muted-foreground/40 hover:bg-muted/50 hover:text-foreground/80',
  },
  compact: {
    base: 'gap-1 rounded-full border px-3 py-1.5 text-[12.5px] leading-[18px] font-medium',
    selected: 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15',
    unselected:
      'border-border bg-card text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground',
  },
};

export function ChipPicker({
  options,
  selected,
  onChange,
  className,
  size = 'default',
}: Readonly<ChipPickerProps>): React.JSX.Element {
  const sizeClasses = CHIP_SIZE_CLASSES[size];
  const toggleOption = (id: string): void => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {options.map((option) => {
        const isSelected = selected.includes(option.id);
        return (
          <motion.button
            key={option.id}
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            data-size={size}
            className={cn(
              'inline-flex cursor-pointer items-center whitespace-nowrap transition-all duration-150 select-none',
              sizeClasses.base,
              isSelected ? sizeClasses.selected : sizeClasses.unselected
            )}
            onClick={() => toggleOption(option.id)}
            whileTap={{ scale: 0.97 }}
          >
            <AnimatePresence mode="wait">
              {isSelected && (
                <motion.span
                  initial={{ scale: 0.5, opacity: 0, width: 0 }}
                  animate={{ scale: 1, opacity: 1, width: 'auto' }}
                  exit={{ scale: 0.5, opacity: 0, width: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center"
                >
                  <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
                </motion.span>
              )}
            </AnimatePresence>
            {option.label}
          </motion.button>
        );
      })}
    </div>
  );
}
