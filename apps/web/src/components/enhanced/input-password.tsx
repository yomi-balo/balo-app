'use client';

import * as React from 'react';
import { Eye, EyeClosed } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface InputPasswordProps extends Omit<React.ComponentProps<'input'>, 'type'> {
  /** Show the strength indicator below the field */
  showStrength?: boolean;
}

const InputPassword = React.forwardRef<HTMLInputElement, InputPasswordProps>(
  ({ showStrength = false, className, value, onChange, ...props }, ref) => {
    const [showPassword, setShowPassword] = React.useState(false);

    const password = typeof value === 'string' ? value : '';

    const validations = [
      { text: 'At least 8 characters', valid: password.length >= 8 },
      { text: 'Contains a number', valid: /\d/.test(password) },
      { text: 'Contains uppercase letter', valid: /[A-Z]/.test(password) },
      { text: 'Contains lowercase letter', valid: /[a-z]/.test(password) },
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
        <div className="relative">
          <Input
            ref={ref}
            type={showPassword ? 'text' : 'password'}
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

        {showStrength && password.length > 0 && (
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
              <span className="text-muted-foreground">Password strength</span>
              <span className={getStrengthTextColor(strength)}>{getStrengthText(strength)}</span>
            </div>
          </div>
        )}
      </div>
    );
  }
);

InputPassword.displayName = 'InputPassword';

export { InputPassword };
