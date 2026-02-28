'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

interface InputFloatingProps extends React.ComponentProps<'input'> {
  label: string;
}

const InputFloating = React.forwardRef<HTMLInputElement, InputFloatingProps>(
  ({ label, id: externalId, className, ...props }, ref) => {
    const internalId = React.useId();
    const id = externalId ?? internalId;

    return (
      <div className="group relative w-full">
        <label
          htmlFor={id}
          className={cn(
            'text-muted-foreground group-focus-within:text-foreground',
            'has-[+input:not(:placeholder-shown)]:text-foreground',
            'origin-start absolute top-1/2 block -translate-y-1/2 cursor-text px-2 text-sm',
            'transition-all duration-200',
            'group-focus-within:pointer-events-none group-focus-within:top-0',
            'group-focus-within:cursor-default group-focus-within:text-xs group-focus-within:font-medium',
            'has-[+input:not(:placeholder-shown)]:pointer-events-none',
            'has-[+input:not(:placeholder-shown)]:top-0',
            'has-[+input:not(:placeholder-shown)]:cursor-default',
            'has-[+input:not(:placeholder-shown)]:text-xs',
            'has-[+input:not(:placeholder-shown)]:font-medium'
          )}
        >
          <span className="bg-background inline-flex px-1">{label}</span>
        </label>
        <Input
          ref={ref}
          id={id}
          placeholder=" "
          className={cn('dark:bg-background h-11', className)}
          {...props}
        />
      </div>
    );
  }
);

InputFloating.displayName = 'InputFloating';

export { InputFloating };
