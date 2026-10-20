'use client';

/**
 * Password input with a requirements checklist — adapted from @shadcn-space/input-04.
 * Registry source: shadcn-space/input/input-04.tsx
 * Balo adaptations: forwardRef for RHF, floating label (from input-09),
 * semantic color tokens, h-11 density. No strength score: WorkOS decides
 * strength on submit, so a local score would promise what the server may refuse.
 */

import * as React from 'react';
import { CheckCircle2, Eye, EyeClosed, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PASSWORD_MIN_LENGTH } from '@/components/balo/auth/schemas';

interface InputPasswordProps extends Omit<React.ComponentProps<'input'>, 'type'> {
  /** Floating label text */
  label: string;
  /** Show the password requirements below the field */
  showRequirements?: boolean;
}

const InputPassword = React.forwardRef<HTMLInputElement, InputPasswordProps>(
  (
    { label, showRequirements = false, className, id: externalId, value, onChange, ...props },
    ref
  ) => {
    const [isVisible, setIsVisible] = React.useState(false);
    const internalId = React.useId();
    const id = externalId ?? internalId;

    const pwd = typeof value === 'string' ? value : '';

    const meetsMinLength = pwd.length >= PASSWORD_MIN_LENGTH;

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

        {/* Requirements (input-04 checklist pattern). Length is the only rule checkable
            here — WorkOS scores guessability and checks breaches on submit. */}
        {showRequirements && pwd.length > 0 && (
          <div className="space-y-1.5 text-xs">
            <div
              className={cn(
                'flex items-center gap-2 transition-colors duration-200',
                meetsMinLength ? 'text-success' : 'text-muted-foreground'
              )}
            >
              {meetsMinLength ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <X className="h-3.5 w-3.5 shrink-0" />
              )}
              At least {PASSWORD_MIN_LENGTH} characters
            </div>
            <p className="text-muted-foreground">
              Avoid common passwords. A few unrelated words make a strong one.
            </p>
          </div>
        )}
      </div>
    );
  }
);

InputPassword.displayName = 'InputPassword';

export { InputPassword };
