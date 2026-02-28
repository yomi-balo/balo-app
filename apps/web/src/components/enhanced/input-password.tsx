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

function getStrength(value: string): {
  score: number;
  label: string;
  color: string;
  textColor: string;
} {
  let score = 0;
  if (value.length >= 8) score++;
  if (/[A-Z]/.test(value)) score++;
  if (/[0-9]/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;

  if (score <= 1)
    return { score, label: 'Weak', color: 'bg-destructive', textColor: 'text-destructive' };
  if (score === 2) return { score, label: 'Fair', color: 'bg-warning', textColor: 'text-warning' };
  if (score === 3) return { score, label: 'Good', color: 'bg-info', textColor: 'text-info' };
  return { score, label: 'Strong', color: 'bg-success', textColor: 'text-success' };
}

function InputPassword({
  label = 'Password',
  error,
  showStrength = false,
  className,
  onChange,
  ref,
  ...props
}: InputPasswordProps): React.JSX.Element {
  const [visible, setVisible] = React.useState(false);
  const [value, setValue] = React.useState('');
  const strength = showStrength ? getStrength(value) : null;

  return (
    <div className="space-y-2">
      <div className="relative">
        <InputFloating
          ref={ref}
          label={label}
          type={visible ? 'text' : 'password'}
          error={error}
          className={cn('pr-10', className)}
          onChange={(e) => {
            setValue(e.target.value);
            onChange?.(e);
          }}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((s) => !s)}
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 transition-colors duration-150"
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {showStrength && value.length > 0 && strength && (
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

export { InputPassword };
