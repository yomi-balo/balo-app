'use client';

import * as React from 'react';
import { Check, Eye, EyeClosed, X } from 'lucide-react';
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
    const [showPassword, setShowPassword] = React.useState(false);
    const internalId = React.useId();
    const id = externalId ?? internalId;

    const password = typeof value === 'string' ? value : '';

    const requirements = [
      { text: 'At least 8 characters', valid: password.length >= 8 },
      { text: 'Lowercase letter (a-z)', valid: /[a-z]/.test(password) },
      { text: 'Uppercase letter (A-Z)', valid: /[A-Z]/.test(password) },
      { text: 'Number (0-9)', valid: /\d/.test(password) },
    ];

    const strength = requirements.filter((r) => r.valid).length;

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
      return 'Very strong';
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
        {/* Floating label + password input */}
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
            type={showPassword ? 'text' : 'password'}
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
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? (
              <Eye className="text-muted-foreground h-4 w-4" />
            ) : (
              <EyeClosed className="text-muted-foreground h-4 w-4" />
            )}
            <span className="sr-only">{showPassword ? 'Hide password' : 'Show password'}</span>
          </Button>
        </div>

        {/* Strength meter + requirement checklist */}
        {showStrength && password.length > 0 && (
          <div className="space-y-2.5">
            {/* Progress bar */}
            <div className="space-y-1.5">
              <div className="bg-secondary h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-500 ease-out',
                    getStrengthColor(strength)
                  )}
                  style={{ width: `${(strength / 4) * 100}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="text-muted-foreground">Password strength</span>
                <span className={getStrengthTextColor(strength)}>{getStrengthText(strength)}</span>
              </div>
            </div>

            {/* Requirement checklist */}
            <ul className="space-y-1" aria-label="Password requirements">
              {requirements.map((req) => (
                <li
                  key={req.text}
                  className={cn(
                    'flex items-center gap-2 text-xs transition-colors duration-200',
                    req.valid ? 'text-success' : 'text-muted-foreground'
                  )}
                >
                  {req.valid ? (
                    <Check className="h-3 w-3 shrink-0" />
                  ) : (
                    <X className="h-3 w-3 shrink-0" />
                  )}
                  {req.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
);

InputPassword.displayName = 'InputSecureField';

export { InputPassword };
