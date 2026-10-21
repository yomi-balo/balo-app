'use client';

import { useCallback, useId, useState } from 'react';
import { Check, ChevronDown, Clock, Coins, FileText, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import {
  ProposalDocumentUploaderView,
  type ProposalDocumentUploadController,
} from './proposal-document-uploader';
import { STANDARD_TERMS } from './proposal-standard-terms';
import { pricingMethodLabel } from './proposal-summary-cells';
import type { ProposalPricingMethod } from './proposal-composer-state';

interface ComposerPropertyBarProps {
  pricingMethod: ProposalPricingMethod;
  onPricingMethodChange: (method: ProposalPricingMethod) => void;
  timeframeWeeks: number | null;
  onTimeframeChange: (weeks: number | null) => void;
  /** The expert's own terms supplement (`kind:'terms'`), if attached. */
  termsDocuments: ProposalDocumentView[];
  termsUpload: ProposalDocumentUploadController;
  /** Trailing slot of the row, announced politely (the draft save status). */
  trailing?: React.ReactNode;
}

const METHOD_OPTIONS: { value: ProposalPricingMethod; description: string }[] = [
  {
    value: 'fixed',
    description: 'One agreed price, paid in installments across the project.',
  },
  {
    value: 'tm',
    description: 'An hourly rate plus a deposit. Milestones are a guide, not a cap.',
  },
];

const CHIP_CLASS =
  'border-border bg-card text-foreground/80 hover:bg-muted focus-visible:ring-ring inline-flex h-11 items-center gap-1.5 rounded-[9px] border px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:h-9';
const POPOVER_CLASS = 'w-[min(20rem,calc(100vw-2rem))] rounded-[14px] p-1.5';
const LINK_BUTTON_CLASS =
  'text-primary focus-visible:ring-ring min-h-6 rounded text-[13.5px] font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none';
const STEP_BUTTON_CLASS =
  'border-border hover:bg-muted focus-visible:ring-ring flex size-11 items-center justify-center rounded-[9px] border transition-colors focus-visible:ring-2 focus-visible:outline-none sm:size-9';

function timeframeLabel(weeks: number | null): string {
  if (weeks === null) return 'Add timeframe';
  return `About ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
}

interface PricingChipProps {
  pricingMethod: ProposalPricingMethod;
  onChange: (method: ProposalPricingMethod) => void;
}

function PricingChip({ pricingMethod, onChange }: Readonly<PricingChipProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const handlePick = useCallback(
    (method: ProposalPricingMethod): void => {
      setOpen(false);
      onChange(method);
    },
    [onChange]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={CHIP_CLASS}>
          <Coins className="text-muted-foreground size-3.5" aria-hidden="true" />
          {pricingMethodLabel(pricingMethod)}
          <ChevronDown className="text-muted-foreground size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Pricing method" className={POPOVER_CLASS}>
        <div role="radiogroup" aria-label="Pricing method">
          {METHOD_OPTIONS.map(({ value, description }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={pricingMethod === value}
              onClick={() => handlePick(value)}
              className="hover:bg-muted focus-visible:ring-ring grid min-h-11 w-full grid-cols-[minmax(0,1fr)_1.125rem] gap-2.5 rounded-[10px] px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none"
            >
              <span>
                <span className="text-foreground block text-sm font-medium">
                  {pricingMethodLabel(value)}
                </span>
                <span className="text-muted-foreground mt-0.5 block text-[13px] leading-snug">
                  {description}
                </span>
              </span>
              {pricingMethod === value ? (
                <Check className="text-primary mt-0.5 size-4" aria-hidden="true" />
              ) : (
                <span />
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface TimeframeChipProps {
  weeks: number | null;
  onChange: (weeks: number | null) => void;
}

function TimeframeChip({ weeks, onChange }: Readonly<TimeframeChipProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const digits = event.target.value.replaceAll(/\D/g, '').slice(0, 3);
      onChange(digits === '' ? null : Math.max(1, Number.parseInt(digits, 10)));
    },
    [onChange]
  );

  const handleRemove = useCallback((): void => {
    onChange(null);
    setOpen(false);
  }, [onChange]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(CHIP_CLASS, weeks === null && 'text-muted-foreground border-dashed')}
        >
          <Clock className="text-muted-foreground size-3.5" aria-hidden="true" />
          {timeframeLabel(weeks)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Timeframe" className={POPOVER_CLASS}>
        <div className="px-3 pt-2.5 pb-3">
          <p className="text-muted-foreground mb-3 text-[13.5px]">
            Roughly how long the work will take. A duration, not a date.
          </p>
          <div className="mb-2.5 flex items-center gap-2">
            <button
              type="button"
              aria-label="Fewer weeks"
              className={STEP_BUTTON_CLASS}
              onClick={() => onChange(Math.max(1, (weeks ?? 1) - 1))}
            >
              <Minus className="size-3.5" aria-hidden="true" />
            </button>
            <input
              aria-label="Weeks"
              inputMode="numeric"
              value={weeks ?? ''}
              onChange={handleInput}
              className="border-border bg-background focus-visible:ring-ring h-11 w-16 rounded-[9px] border text-center text-[15px] tabular-nums focus-visible:ring-2 focus-visible:outline-none sm:h-9"
            />
            <button
              type="button"
              aria-label="More weeks"
              className={STEP_BUTTON_CLASS}
              onClick={() => onChange((weeks ?? 0) + 1)}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </button>
            <span className="text-muted-foreground text-sm">weeks</span>
          </div>
          {weeks !== null && (
            <button type="button" className={LINK_BUTTON_CLASS} onClick={handleRemove}>
              Remove timeframe
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface TermsChipProps {
  documents: ProposalDocumentView[];
  upload: ProposalDocumentUploadController;
}

function TermsChip({ documents, upload }: Readonly<TermsChipProps>): React.JSX.Element {
  const labelId = useId();
  const hasOwnTerms = documents.length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={CHIP_CLASS}>
          <FileText className="text-muted-foreground size-3.5" aria-hidden="true" />
          {hasOwnTerms ? 'Balo standard and your terms' : 'Balo standard terms'}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Terms"
        className={cn(POPOVER_CLASS, 'w-[min(24rem,calc(100vw-2rem))]')}
      >
        <div className="px-3 pt-2.5 pb-3">
          <p id={labelId} className="text-muted-foreground mb-2 text-[13.5px]">
            Balo standard terms apply to every proposal. You can attach your own terms to sit
            alongside them.
          </p>
          <ul className="text-muted-foreground mb-3 list-disc space-y-1 pl-4 text-[12.5px]">
            {STANDARD_TERMS.map((term) => (
              <li key={term}>{term}</li>
            ))}
          </ul>
          <ProposalDocumentUploaderView
            controller={upload}
            documents={documents}
            labelId={labelId}
            single
            pickLabel="Attach your terms"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The choices that shape everything below, as three popover chips: pricing method,
 * timeframe and terms. The trailing slot carries the draft save status and owns its own live-region semantics.
 */
export function ComposerPropertyBar({
  pricingMethod,
  onPricingMethodChange,
  timeframeWeeks,
  onTimeframeChange,
  termsDocuments,
  termsUpload,
  trailing,
}: Readonly<ComposerPropertyBarProps>): React.JSX.Element {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <PricingChip pricingMethod={pricingMethod} onChange={onPricingMethodChange} />
      <TimeframeChip weeks={timeframeWeeks} onChange={onTimeframeChange} />
      <TermsChip documents={termsDocuments} upload={termsUpload} />
      <div className="ml-auto">{trailing}</div>
    </div>
  );
}
