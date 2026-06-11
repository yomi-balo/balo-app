'use client';

import { useCallback, useRef } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RichTextEditor } from '@/components/balo/rich-text-editor';
import type { ProposalPricingMethod } from './proposal-composer-state';

interface PricingMethodCard {
  value: ProposalPricingMethod;
  title: string;
  description: string;
}

const METHOD_CARDS: PricingMethodCard[] = [
  {
    value: 'fixed',
    title: 'Fixed price',
    description: 'One agreed price, split into milestone-based installments.',
  },
  {
    value: 'tm',
    title: 'Time & materials',
    description: 'An hourly rate plus a deposit; milestones are a guide, not a cap.',
  },
];

interface OverviewTabProps {
  overview: string;
  onOverviewChange: (html: string) => void;
  pricingMethod: ProposalPricingMethod;
  onPricingMethodChange: (method: ProposalPricingMethod) => void;
  timeframeWeeks: number | null;
  onTimeframeChange: (weeks: number | null) => void;
  exclusions: string;
  onExclusionsChange: (value: string) => void;
}

/**
 * Overview pane: the full-variant TipTap overview editor, THEN the pricing-method
 * selector (placed BEFORE milestones because it reshapes them), THEN the
 * timeframe-in-weeks input and the optional exclusions textarea.
 */
export function OverviewTab({
  overview,
  onOverviewChange,
  pricingMethod,
  onPricingMethodChange,
  timeframeWeeks,
  onTimeframeChange,
  exclusions,
  onExclusionsChange,
}: Readonly<OverviewTabProps>): React.JSX.Element {
  const handleTimeframe = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const raw = event.target.value.trim();
      if (raw === '') {
        onTimeframeChange(null);
        return;
      }
      const parsed = Number.parseInt(raw, 10);
      onTimeframeChange(Number.isNaN(parsed) || parsed < 1 ? null : parsed);
    },
    [onTimeframeChange]
  );

  const handleExclusions = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => onExclusionsChange(event.target.value),
    [onExclusionsChange]
  );

  const handleMethod = useCallback(
    (method: ProposalPricingMethod) => () => onPricingMethodChange(method),
    [onPricingMethodChange]
  );

  // Roving-focus refs so an arrow-key move also moves DOM focus to the newly
  // selected radio (one radio is `tabIndex=0`, the rest `-1`).
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleMethodKeyDown = useCallback(
    (index: number) =>
      (event: React.KeyboardEvent<HTMLButtonElement>): void => {
        const { key } = event;
        let nextIndex: number | null = null;
        if (key === 'ArrowRight' || key === 'ArrowDown') {
          nextIndex = (index + 1) % METHOD_CARDS.length;
        } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
          nextIndex = (index - 1 + METHOD_CARDS.length) % METHOD_CARDS.length;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        const nextCard = METHOD_CARDS[nextIndex];
        if (nextCard === undefined) return;
        onPricingMethodChange(nextCard.value);
        cardRefs.current[nextIndex]?.focus();
      },
    [onPricingMethodChange]
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="proposal-overview" id="proposal-overview-label">
          Overview
        </Label>
        <p className="text-muted-foreground text-[13px]">
          Describe the work, your approach, and what the client can expect. Use{' '}
          <span className="font-mono">/</span> for headings and lists.
        </p>
        <RichTextEditor
          variant="full"
          collapseOnBlur
          value={overview}
          onChange={onOverviewChange}
          ariaLabel="Proposal overview"
          placeholder="Outline the engagement…"
        />
      </div>

      <fieldset className="space-y-2">
        <legend id="pricing-method-legend" className="text-foreground text-sm font-medium">
          Pricing method
        </legend>
        <p className="text-muted-foreground text-[13px]">
          This shapes the rest of your proposal — change it here, not in Payment.
        </p>
        <div
          role="radiogroup"
          aria-labelledby="pricing-method-legend"
          className="grid gap-3 sm:grid-cols-2"
        >
          {METHOD_CARDS.map((card, index) => {
            const isActive = card.value === pricingMethod;
            return (
              <button
                key={card.value}
                ref={(node) => {
                  cardRefs.current[index] = node;
                }}
                type="button"
                role="radio"
                aria-checked={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={handleMethod(card.value)}
                onKeyDown={handleMethodKeyDown(index)}
                className={cn(
                  'focus-visible:ring-ring relative rounded-[12px] border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
                  isActive
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card hover:border-primary/40'
                )}
              >
                <span className="flex items-center justify-between">
                  <span className="text-foreground text-sm font-semibold">{card.title}</span>
                  {isActive && (
                    <span className="bg-primary flex h-5 w-5 items-center justify-center rounded-full">
                      <Check className="text-primary-foreground h-3 w-3" aria-hidden="true" />
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground mt-1 block text-[13px] leading-relaxed">
                  {card.description}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="proposal-timeframe">Estimated timeframe</Label>
        <div className="flex items-center gap-2">
          <Input
            id="proposal-timeframe"
            type="number"
            inputMode="numeric"
            min={1}
            value={timeframeWeeks ?? ''}
            onChange={handleTimeframe}
            className="w-28"
            placeholder="6"
          />
          <span className="text-muted-foreground text-sm">weeks</span>
        </div>
        <p className="text-muted-foreground text-[12px]">
          A duration, not a date — roughly how long the work will take.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="proposal-exclusions">What&apos;s not included (optional)</Label>
        <Textarea
          id="proposal-exclusions"
          value={exclusions}
          onChange={handleExclusions}
          rows={3}
          placeholder="Anything explicitly out of scope…"
        />
      </div>
    </div>
  );
}
