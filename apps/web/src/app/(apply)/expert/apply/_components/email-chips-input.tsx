'use client';

import { forwardRef, useCallback, useImperativeHandle, useState } from 'react';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Badge } from '@/components/ui/badge';

/**
 * Lightweight, dependency-free email validity check (lifted from the retired
 * expert-apply invite step). Rejects addresses over 254 chars, requires a local
 * part before `@`, a dot after the `@`, and no spaces. The server action
 * (referralInviteInputSchema) is authoritative — this only gates chip creation.
 */
export function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  const at = email.indexOf('@');
  const dot = email.lastIndexOf('.');
  return at > 0 && dot > at + 1 && dot < email.length - 1 && !email.includes(' ');
}

interface EmailChipsInputProps {
  value: string[];
  onChange: (emails: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  maxEmails?: number;
  id?: string;
  'aria-label'?: string;
}

/**
 * Imperative handle exposed via `ref`. `flush()` commits any pending
 * (typed-but-not-Enter'd) input text into the address list and returns the
 * resulting full list synchronously — so a send handler can include the last
 * typed address deterministically, without depending on blur→rerender→click order.
 */
export interface EmailChipsInputHandle {
  flush: () => string[];
}

const DEFAULT_MAX_EMAILS = 20;

/**
 * Controlled email chips input. Owns only its raw text-input state internally;
 * the parsed, validated, de-duplicated address list is lifted to the parent via
 * `value` / `onChange`. Parses on Enter, comma, and blur. No react-hook-form and
 * no wizard coupling — reusable anywhere a bag of emails is collected.
 */
export const EmailChipsInput = forwardRef<EmailChipsInputHandle, Readonly<EmailChipsInputProps>>(
  function EmailChipsInput(
    {
      value,
      onChange,
      disabled = false,
      placeholder = 'sarah@example.com, james@acme.com',
      maxEmails = DEFAULT_MAX_EMAILS,
      id,
      'aria-label': ariaLabel,
    },
    ref
  ): React.JSX.Element {
    const [inputValue, setInputValue] = useState('');

    // Parse `raw`, merge valid/new/under-cap addresses into `value`, clear the
    // input, and return the resulting full list (so callers can flush + read in
    // one synchronous step).
    const addEmails = useCallback(
      (raw: string): string[] => {
        const candidates = raw
          .split(/[,\s]+/)
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0);

        const existingSet = new Set(value);
        const additions: string[] = [];
        for (const candidate of candidates) {
          if (value.length + additions.length >= maxEmails) break;
          if (!isValidEmail(candidate)) continue;
          if (existingSet.has(candidate)) continue;
          existingSet.add(candidate);
          additions.push(candidate);
        }

        const next = additions.length > 0 ? [...value, ...additions] : value;
        if (additions.length > 0) {
          onChange(next);
        }
        setInputValue('');
        return next;
      },
      [value, onChange, maxEmails]
    );

    useImperativeHandle(ref, () => ({ flush: (): string[] => addEmails(inputValue) }), [
      addEmails,
      inputValue,
    ]);

    const removeEmail = useCallback(
      (email: string): void => {
        onChange(value.filter((e) => e !== email));
      },
      [value, onChange]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          addEmails(inputValue);
        }
      },
      [addEmails, inputValue]
    );

    const handleBlur = useCallback((): void => {
      if (inputValue.trim()) {
        addEmails(inputValue);
      }
    }, [addEmails, inputValue]);

    const atCapacity = value.length >= maxEmails;

    return (
      <div className="space-y-3">
        {/* Email chips */}
        <AnimatePresence>
          {value.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="flex flex-wrap gap-2"
            >
              {value.map((email) => (
                <motion.div
                  key={email}
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Badge variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
                    {email}
                    <button
                      type="button"
                      onClick={() => removeEmail(email)}
                      disabled={disabled}
                      className="hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                      aria-label={`Remove ${email}`}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </Badge>
                </motion.div>
              ))}
              <p className="text-muted-foreground mt-1 w-full text-xs">
                {value.length} invitation{value.length === 1 ? '' : 's'} ready to send
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Email textarea */}
        <textarea
          id={id}
          aria-label={ariaLabel}
          className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[120px] w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={placeholder}
          value={inputValue}
          disabled={disabled || atCapacity}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
        />

        <p className="text-muted-foreground text-xs">
          Enter email addresses separated by commas or new lines.{' '}
          {atCapacity
            ? `You've reached the ${maxEmails}-invitation limit.`
            : "We'll send each person a friendly invitation — one per address, ever."}
        </p>
      </div>
    );
  }
);
