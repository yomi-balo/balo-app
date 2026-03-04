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
}: ChipPickerProps): React.JSX.Element {
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
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors duration-200',
              isSelected
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:border-primary/50'
            )}
            onClick={() => toggleOption(option.id)}
            whileTap={{ scale: 0.95 }}
          >
            <AnimatePresence mode="wait">
              {isSelected && (
                <motion.span
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.5, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Check className="h-3 w-3" aria-hidden="true" />
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
