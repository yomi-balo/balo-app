'use client';

import { useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { BookingFundingMethodProperty } from '@balo/analytics/events';
import { chipClass, nextRadioIndex } from './funding-amount-picker';
import { PAY_AFTER_COPY } from './funding-copy';

interface FundingMethodPickerProps {
  readonly method: BookingFundingMethodProperty;
  readonly onMethodChange: (method: BookingFundingMethodProperty) => void;
  readonly companyName: string | null;
}

const METHOD_IDS: readonly BookingFundingMethodProperty[] = ['topup', 'pay_after'];

function RadioDot({ on }: Readonly<{ on: boolean }>): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]',
        on ? 'border-primary' : 'border-border'
      )}
    >
      {on && <span className="bg-primary size-2 rounded-full" />}
    </span>
  );
}

/**
 * How the booking is paid for: top up now, or pay after the call. A radiogroup of two cards
 * (one column below `sm`); the parent `<fieldset disabled>` disables both while a run is going.
 */
export function FundingMethodPicker({
  method,
  onMethodChange,
  companyName,
}: Readonly<FundingMethodPickerProps>): React.JSX.Element {
  const radioRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = METHOD_IDS.indexOf(method);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const next = nextRadioIndex(event.key, index, METHOD_IDS.length);
      if (next === null) return;
      const target = METHOD_IDS[next];
      if (target === undefined) return;
      event.preventDefault();
      onMethodChange(target);
      radioRefs.current[next]?.focus();
    },
    [onMethodChange]
  );

  const options = [
    {
      id: 'topup',
      title: PAY_AFTER_COPY.topup.title,
      description: PAY_AFTER_COPY.topup.description(companyName),
    },
    {
      id: 'pay_after',
      title: PAY_AFTER_COPY.payAfter.title,
      description: PAY_AFTER_COPY.payAfter.description,
    },
  ] as const;

  return (
    <div
      role="radiogroup"
      aria-label={PAY_AFTER_COPY.methodGroupLabel}
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
    >
      {options.map((option, index) => {
        const on = method === option.id;
        return (
          <button
            key={option.id}
            ref={(node) => {
              radioRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={index === selectedIndex ? 0 : -1}
            onClick={() => onMethodChange(option.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              chipClass(on),
              'min-h-11 flex-row items-start justify-start gap-2.5 px-3.5 py-3 text-left'
            )}
          >
            <span className="mt-0.5">
              <RadioDot on={on} />
            </span>
            <span>
              <span className="text-foreground block text-sm font-semibold">{option.title}</span>
              <span className="text-muted-foreground mt-[3px] block text-[12.5px] leading-snug">
                {option.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
