'use client';

import { useCallback } from 'react';
import { CreditCard, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FundingMethod } from './types';

interface FundingChoiceProps {
  readonly funding: FundingMethod;
  readonly onFundingChange: (funding: FundingMethod) => void;
}

/**
 * BAL-377 "Pay with" — Card / Invoice-transfer radio-cards. Invoice is v1-DEFERRED (LOCKED
 * decision): visible but DISABLED with a "Coming soon" pill so the mental model is set and
 * the Card path is unambiguous. Card is the only selectable funding in v1.
 */
export function FundingChoice({ funding, onFundingChange }: Readonly<FundingChoiceProps>) {
  const selectCard = useCallback(() => onFundingChange('card'), [onFundingChange]);

  return (
    <div>
      <div className="text-foreground mb-2.5 text-sm font-semibold">Pay with</div>
      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={selectCard}
          aria-pressed={funding === 'card'}
          className={cn(
            'focus-visible:ring-ring flex items-center gap-2.5 rounded-xl border p-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
            funding === 'card'
              ? 'border-primary bg-primary/5'
              : 'border-border bg-card hover:bg-accent/40'
          )}
        >
          <CreditCard
            className={cn('size-4', funding === 'card' ? 'text-primary' : 'text-muted-foreground')}
            strokeWidth={2.2}
            aria-hidden="true"
          />
          <span className="text-foreground text-sm font-semibold">Card</span>
        </button>

        <div
          aria-disabled="true"
          className="border-border bg-muted/40 flex cursor-not-allowed items-center justify-between gap-2 rounded-xl border p-3.5 text-left opacity-70"
        >
          <span className="flex items-center gap-2.5">
            <FileText
              className="text-muted-foreground size-4"
              strokeWidth={2.2}
              aria-hidden="true"
            />
            <span className="text-muted-foreground text-sm font-semibold">Invoice / transfer</span>
          </span>
          <span className="border-border bg-background text-muted-foreground rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
            Coming soon
          </span>
        </div>
      </div>
    </div>
  );
}
