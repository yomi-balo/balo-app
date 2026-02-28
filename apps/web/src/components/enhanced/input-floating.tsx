'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface InputFloatingProps extends Omit<React.ComponentProps<'input'>, 'placeholder'> {
  label: string;
  error?: boolean;
}

const InputFloating = React.forwardRef<HTMLInputElement, InputFloatingProps>(
  ({ className, label, error, type = 'text', id, onFocus, onBlur, onChange, ...props }, ref) => {
    const [isFocused, setIsFocused] = React.useState(false);
    const [hasValue, setHasValue] = React.useState(false);
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const isFloating = isFocused || hasValue;

    // Handle autofill / defaultValue on mount
    const internalRef = React.useRef<HTMLInputElement | null>(null);
    React.useEffect(() => {
      if (internalRef.current && internalRef.current.value.length > 0) {
        setHasValue(true);
      }
    }, []);

    return (
      <div className="relative">
        <input
          ref={(node) => {
            internalRef.current = node;
            if (typeof ref === 'function') {
              ref(node);
            } else if (ref) {
              ref.current = node;
            }
          }}
          id={inputId}
          type={type}
          className={cn(
            'peer h-12 w-full rounded-lg border bg-transparent px-3 pt-5 pb-2 text-base transition-all duration-200 outline-none md:text-sm',
            'border-input focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'dark:bg-input/30',
            'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
            error &&
              'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20',
            className
          )}
          onFocus={(e) => {
            setIsFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setIsFocused(false);
            setHasValue(e.target.value.length > 0);
            onBlur?.(e);
          }}
          onChange={(e) => {
            setHasValue(e.target.value.length > 0);
            onChange?.(e);
          }}
          {...props}
        />
        <label
          htmlFor={inputId}
          className={cn(
            'pointer-events-none absolute left-3 transition-all duration-200 ease-out',
            isFloating ? 'top-2 text-xs' : 'top-1/2 -translate-y-1/2 text-sm',
            isFocused ? 'text-primary' : 'text-muted-foreground',
            error && 'text-destructive'
          )}
        >
          {label}
        </label>
      </div>
    );
  }
);
InputFloating.displayName = 'InputFloating';

export { InputFloating };
