'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InputFloating } from './input-floating';

interface InputPasswordProps extends Omit<React.ComponentProps<'input'>, 'type' | 'placeholder'> {
  label?: string;
  error?: boolean;
  showStrength?: boolean;
}

function getPasswordStrength(password: string): {
  score: number;
  label: string;
  color: string;
  textColor: string;
} {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1)
    return { score, label: 'Weak', color: 'bg-destructive', textColor: 'text-destructive' };
  if (score === 2) return { score, label: 'Fair', color: 'bg-warning', textColor: 'text-warning' };
  if (score === 3) return { score, label: 'Good', color: 'bg-info', textColor: 'text-info' };
  return { score, label: 'Strong', color: 'bg-success', textColor: 'text-success' };
}

const InputPassword = React.forwardRef<HTMLInputElement, InputPasswordProps>(
  ({ label = 'Password', error, showStrength = false, className, onChange, ...props }, ref) => {
    const [showPassword, setShowPassword] = React.useState(false);
    const [password, setPassword] = React.useState('');
    const strength = showStrength ? getPasswordStrength(password) : null;

    return (
      <div className="space-y-2">
        <div className="relative">
          <InputFloating
            ref={ref}
            label={label}
            type={showPassword ? 'text' : 'password'}
            error={error}
            className={cn('pr-10', className)}
            onChange={(e) => {
              setPassword(e.target.value);
              onChange?.(e);
            }}
            {...props}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPassword((s) => !s)}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 transition-colors duration-150"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {showStrength && password.length > 0 && strength && (
          <div className="space-y-1.5">
            <div className="flex gap-1">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-colors duration-300',
                    i < strength.score ? strength.color : 'bg-muted'
                  )}
                />
              ))}
            </div>
            <p className={cn('text-xs transition-colors duration-300', strength.textColor)}>
              {strength.label}
            </p>
          </div>
        )}
      </div>
    );
  }
);
InputPassword.displayName = 'InputPassword';

export { InputPassword };
