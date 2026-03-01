'use client';

/**
 * Password input with strength meter — adapted from @shadcn-space/input-04.
 * Registry source: shadcn-space/input/input-04.tsx
 * Balo adaptations: forwardRef for RHF, floating label (from input-09),
 * semantic color tokens (destructive/warning/info/success), h-11 density.
 */

import * as React from 'react';
import { CheckCircle2, Eye, EyeClosed, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface InputPasswordProps extends Omit<React.ComponentProps<'input'>, 'type'> {
  /** Floating label text */
  label: string;
  /** Show the strength indicator + requirements below the field */
  showStrength?: boolean;
}

const InputPassword = React.forwardRef<HTMLInputElement, InputPasswordProps>(
  ({ label, showStrength = false, className, id: externalId, value, onChange, ...props }, ref) => {
    const [isVisible, setIsVisible] = React.useState(false);
    const internalId = React.useId();
    const id = externalId ?? internalId;

    const pwd = typeof value === 'string' ? value : '';

    const validations = [
      { text: 'At least 8 characters', valid: pwd.length >= 8 },
      { text: 'Contains lowercase letter', valid: /[a-z]/.test(pwd) },
      { text: 'Contains uppercase letter', valid: /[A-Z]/.test(pwd) },
      { text: 'Contains a number', valid: /\d/.test(pwd) },
    ];

    const strength = validations.filter((v) => v.valid).length;

    const getStrengthColor = (score: number): string => {
      if (score === 0) return 'bg-muted';
      if (score <= 1) return 'bg-destructive';
      if (score <= 2) return 'bg-warning';
      if (score <= 3) return 'bg-info';
      return 'bg-success';
    };

    const getStrengthText = (score: number): string => {
      if (score === 0) return '';
      if (score <= 1) return 'Weak';
      if (score <= 2) return 'Moderate';
      if (score <= 3) return 'Strong';
      return 'Very Strong';
    };

    const getStrengthTextColor = (score: number): string => {
      if (score === 0) return 'text-muted-foreground';
      if (score <= 1) return 'text-destructive';
      if (score <= 2) return 'text-warning';
      if (score <= 3) return 'text-info';
      return 'text-success';
    };

    return (
      <div className="w-full space-y-3">
        {/* Floating label + password input (input-09 pattern) */}
        <div className="group relative w-full">
          <label
            htmlFor={id}
            className={cn(
              'text-muted-foreground group-focus-within:text-foreground',
              'has-[+input:not(:placeholder-shown)]:text-foreground',
              'has-[+input:-webkit-autofill]:text-foreground',
              'origin-start absolute top-1/2 block -translate-y-1/2 cursor-text px-2 text-sm',
              'transition-all duration-200',
              'group-focus-within:pointer-events-none group-focus-within:top-0',
              'group-focus-within:cursor-default group-focus-within:text-xs group-focus-within:font-medium',
              'has-[+input:not(:placeholder-shown)]:pointer-events-none',
              'has-[+input:not(:placeholder-shown)]:top-0',
              'has-[+input:not(:placeholder-shown)]:cursor-default',
              'has-[+input:not(:placeholder-shown)]:text-xs',
              'has-[+input:not(:placeholder-shown)]:font-medium',
              'has-[+input:-webkit-autofill]:pointer-events-none',
              'has-[+input:-webkit-autofill]:top-0',
              'has-[+input:-webkit-autofill]:cursor-default',
              'has-[+input:-webkit-autofill]:text-xs',
              'has-[+input:-webkit-autofill]:font-medium'
            )}
          >
            <span className="bg-background inline-flex px-1">{label}</span>
          </label>
          <Input
            ref={ref}
            id={id}
            type={isVisible ? 'text' : 'password'}
            placeholder=" "
            value={value}
            onChange={onChange}
            className={cn('dark:bg-background h-11 pr-10', className)}
            {...props}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="focus-visible:ring-ring absolute top-0 right-0 h-full px-3 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-offset-2"
            onClick={() => setIsVisible(!isVisible)}
          >
            {isVisible ? (
              <Eye className="text-muted-foreground h-4 w-4" />
            ) : (
              <EyeClosed className="text-muted-foreground h-4 w-4" />
            )}
            <span className="sr-only">{isVisible ? 'Hide password' : 'Show password'}</span>
          </Button>
        </div>

        {/* Strength meter + validation checklist (input-04 pattern) */}
        {showStrength && pwd.length > 0 && (
          <div className="space-y-2">
            <div className="bg-secondary h-1 w-full overflow-hidden rounded-full">
              <div
                className={cn(
                  'h-full transition-all duration-500 ease-out',
                  getStrengthColor(strength)
                )}
                style={{ width: `${(strength / 4) * 100}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="text-muted-foreground">Password must contain</span>
              <span className={getStrengthTextColor(strength)}>{getStrengthText(strength)}</span>
            </div>

            <div className="space-y-1.5 pt-1">
              {validations.map((v) => (
                <div
                  key={v.text}
                  className={cn(
                    'flex items-center gap-2 text-xs transition-colors duration-200',
                    v.valid ? 'text-success' : 'text-muted-foreground'
                  )}
                >
                  {v.valid ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <X className="h-3.5 w-3.5 shrink-0" />
                  )}
                  {v.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
);

InputPassword.displayName = 'InputPassword';

export { InputPassword };
