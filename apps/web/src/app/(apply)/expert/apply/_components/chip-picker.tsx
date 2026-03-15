'use client';

import { Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';

interface ChipOption {
  id: string;
  label: string;
}

interface ChipPickerProps {
  options: ChipOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  className?: string;
}

export function ChipPicker({
  options,
  selected,
  onChange,
  className,
}: Readonly<ChipPickerProps>): React.JSX.Element {
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
            className={cn(
              'inline-flex h-8 cursor-pointer items-center gap-[5px] rounded-[20px] border-[1.5px] px-3 text-[13px] font-medium whitespace-nowrap transition-all duration-150 select-none',
              isSelected
                ? 'border-primary bg-primary/[0.08] text-primary hover:border-primary/80 hover:bg-primary/[0.12] font-semibold'
                : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/40 hover:bg-muted/50 hover:text-foreground/80'
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
