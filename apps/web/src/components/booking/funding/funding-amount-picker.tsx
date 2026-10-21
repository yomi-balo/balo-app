'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import { Check, Gift } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatAud, formatAudShort } from '@/lib/credit/display-constants';
import { otherAmountHint } from './funding-amount';

interface FundingAmountPickerProps {
  readonly chips: readonly number[];
  /** The selected quick-pick; ignored while `other` is on. */
  readonly amountMinor: number;
  readonly onAmountChange: (amountMinor: number) => void;
  readonly other: boolean;
  readonly onOtherChange: (other: boolean) => void;
  readonly otherValue: string;
  readonly onOtherValueChange: (value: string) => void;
  /** Why the typed amount is not usable, or `null`. Shown only once something is typed. */
  readonly otherError: string | null;
  /** The smallest amount the booking needs, for the helper line and the placeholder. */
  readonly minMinor: number;
  /** The amount that will be charged, or `null` while "Other" holds nothing usable. */
  readonly effectiveMinor: number | null;
  readonly promoMinor: number;
  /** The company, as it reads before "balance": "Northwind's". */
  readonly companyLabel: string;
}

const CHIP_BASE =
  'relative flex min-h-[58px] flex-col items-center justify-center rounded-xl border-[1.5px] px-1.5 py-2.5 transition-colors duration-150 focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none';

export function chipClass(selected: boolean): string {
  return cn(
    CHIP_BASE,
    selected
      ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
      : 'border-border bg-card hover:border-primary/40 enabled:cursor-pointer'
  );
}

/** The index a radiogroup key moves to, or `null` for a key that is not a navigation key. */
export function nextRadioIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

function SelectedMark(): React.JSX.Element {
  return (
    <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full">
      <Check className="size-3" strokeWidth={3} aria-hidden="true" />
    </span>
  );
}

/**
 * The top-up amount: the minimum that makes the booking pass, the standard tiers above it, and
 * "Other" for any whole-hundred amount up to one top-up. Disabling the surrounding `<fieldset>`
 * disables every control here.
 */
export function FundingAmountPicker({
  chips,
  amountMinor,
  onAmountChange,
  other,
  onOtherChange,
  otherValue,
  onOtherValueChange,
  otherError,
  minMinor,
  effectiveMinor,
  promoMinor,
  companyLabel,
}: Readonly<FundingAmountPickerProps>): React.JSX.Element {
  const labelId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const radioRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusInputRef = useRef(false);
  const showError = otherError !== null && otherValue.trim() !== '';

  // Pressing "Other" moves focus to its field; arrowing onto it keeps focus on the radios.
  useEffect(() => {
    if (!other || !focusInputRef.current) return;
    focusInputRef.current = false;
    inputRef.current?.focus();
  }, [other]);

  const optionCount = chips.length + 1;
  const selectedIndex = other ? chips.length : chips.indexOf(amountMinor);
  const tabStopIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const selectOption = useCallback(
    (index: number) => {
      const chip = chips[index];
      if (chip === undefined) {
        onOtherChange(true);
        return;
      }
      onOtherChange(false);
      onAmountChange(chip);
    },
    [chips, onOtherChange, onAmountChange]
  );

  const handleRadioKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const next = nextRadioIndex(event.key, index, optionCount);
      if (next === null) return;
      event.preventDefault();
      selectOption(next);
      radioRefs.current[next]?.focus();
    },
    [optionCount, selectOption]
  );

  const handleOther = useCallback(() => {
    focusInputRef.current = true;
    onOtherChange(true);
  }, [onOtherChange]);
  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => onOtherValueChange(event.target.value),
    [onOtherValueChange]
  );

  return (
    <div>
      <div id={labelId} className="text-foreground mb-2 text-sm font-semibold">
        Amount
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {chips.map((chip, index) => {
          const selected = !other && amountMinor === chip;
          return (
            <button
              key={chip}
              ref={(node) => {
                radioRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={index === tabStopIndex ? 0 : -1}
              onClick={() => selectOption(index)}
              onKeyDown={(event) => handleRadioKeyDown(event, index)}
              className={chipClass(selected)}
            >
              {selected && <SelectedMark />}
              <span className="text-foreground text-[15px] font-bold tabular-nums">
                {formatAudShort(chip)}
              </span>
              {index === 0 && (
                <span
                  className={cn(
                    'mt-0.5 text-[11px] font-semibold',
                    selected ? 'text-primary' : 'text-muted-foreground'
                  )}
                >
                  Minimum
                </span>
              )}
            </button>
          );
        })}
        <button
          ref={(node) => {
            radioRefs.current[chips.length] = node;
          }}
          type="button"
          role="radio"
          aria-checked={other}
          tabIndex={chips.length === tabStopIndex ? 0 : -1}
          onClick={handleOther}
          onKeyDown={(event) => handleRadioKeyDown(event, chips.length)}
          className={chipClass(other)}
        >
          {other && <SelectedMark />}
          <span
            className={cn('text-sm font-semibold', other ? 'text-primary' : 'text-foreground/80')}
          >
            Other
          </span>
        </button>
      </div>

      {other && (
        <div className="mt-2.5">
          <div className="relative">
            <span
              aria-hidden="true"
              className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold"
            >
              A$
            </span>
            <input
              ref={inputRef}
              inputMode="numeric"
              aria-label="Top-up amount in Australian dollars"
              aria-invalid={showError ? true : undefined}
              aria-describedby={hintId}
              value={otherValue}
              onChange={handleInput}
              placeholder={String(minMinor / 100)}
              className={cn(
                'text-foreground placeholder:text-muted-foreground focus-visible:ring-ring min-h-11 w-full rounded-[10px] border-[1.5px] py-2.5 pr-3 pl-9 text-[15px] font-semibold tabular-nums focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60',
                showError ? 'border-destructive bg-destructive/5' : 'border-border bg-card'
              )}
            />
          </div>
          <p
            id={hintId}
            className={cn(
              'mt-1.5 text-xs font-medium',
              showError ? 'text-destructive-strong' : 'text-muted-foreground'
            )}
          >
            {showError ? otherError : otherAmountHint(minMinor)}
          </p>
        </div>
      )}

      {promoMinor > 0 && effectiveMinor !== null && (
        <p className="text-success-strong mt-2.5 flex items-center gap-1.5 text-[12.5px] font-semibold">
          <Gift className="size-3.5" aria-hidden="true" />
          Adds {formatAud(effectiveMinor + promoMinor)} to {companyLabel} balance.
        </p>
      )}
    </div>
  );
}
