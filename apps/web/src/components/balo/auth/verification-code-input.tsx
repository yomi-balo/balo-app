'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

interface VerificationCodeInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  length?: number;
}

export function VerificationCodeInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  autoFocus = false,
  length = 6,
}: Readonly<VerificationCodeInputProps>): React.JSX.Element {
  const inputRefs = React.useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(length, ' ').split('').slice(0, length);

  React.useEffect(() => {
    if (autoFocus) {
      inputRefs.current[0]?.focus();
    }
  }, [autoFocus]);

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (pasted.length > 0) {
      onChange(pasted);
      if (pasted.length === length) {
        onComplete(pasted);
      }
      const focusIndex = Math.min(pasted.length, length - 1);
      inputRefs.current[focusIndex]?.focus();
    }
  };

  const handleChange = (index: number, inputValue: string): void => {
    // Single digit input
    const digit = inputValue.replace(/\D/g, '').slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit || ' ';
    const newValue = newDigits.join('').replace(/ /g, '');
    onChange(newValue);

    if (digit && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newValue.length === length) {
      onComplete(newValue);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace' && digits[index] === ' ' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  return (
    <div
      className="flex gap-2 sm:gap-3"
      role="group"
      aria-label="Verification code"
      aria-describedby="verification-code-hint"
    >
      <span id="verification-code-hint" className="sr-only">
        Enter the 6-digit code sent to your email
      </span>
      {digits.map((digit, index) => (
        <Input
          key={index}
          ref={(el) => {
            inputRefs.current[index] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          value={digit === ' ' ? '' : digit}
          onChange={(e) => handleChange(index, e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => handleKeyDown(index, e)}
          disabled={disabled}
          className={cn(
            'h-12 w-10 text-center text-lg font-semibold sm:h-14 sm:w-12 sm:text-xl',
            'focus-visible:ring-primary'
          )}
          aria-label={`Digit ${index + 1}`}
          aria-required={index === 0 ? true : undefined}
        />
      ))}
    </div>
  );
}
