'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { sumEstimatedMinutes } from '@balo/shared/pricing';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { centsToDollars, formatWholeCurrency } from '@/lib/utils/currency';
import { ComposerSection } from './composer-section';
import { parseDollarsToCents } from './milestones-section';
import { minutesToHoursLabel } from './proposal-format';
import {
  COMPOSER_TARGET,
  INSTALLMENT_PRESETS,
  installmentFieldId,
  installmentsSum,
  matchInstallmentPreset,
  nextDraftKey,
  presetInstallments,
} from './proposal-composer-state';
import type {
  InstallmentPresetKey,
  ProposalCadenceValue,
  ProposalDraftState,
  ProposalInstallmentDraft,
} from './proposal-composer-state';

interface PricingSectionProps {
  state: ProposalDraftState;
  totalCents: number;
  companyName: string;
  onFixedPriceChange: (cents: number | null) => void;
  onInstallmentsChange: (next: ProposalInstallmentDraft[]) => void;
  onDepositChange: (cents: number | null) => void;
  onRateChange: (cents: number | null) => void;
  onCadenceChange: (cadence: ProposalCadenceValue) => void;
}

const CADENCE_OPTIONS: { value: ProposalCadenceValue; label: string }[] = [
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
];

interface MoneyFieldProps {
  id: string;
  label: string;
  help: string;
  valueCents: number | null;
  onChange: (cents: number | null) => void;
  suffix?: string;
  placeholder?: string;
  large?: boolean;
  className?: string;
}

/** Labelled `A$` input that reads/writes integer cents. The wrapper is the
 *  `data-flash` target; the input carries the jump-target id. */
function MoneyField({
  id,
  label,
  help,
  valueCents,
  onChange,
  suffix,
  placeholder = '0.00',
  large = false,
  className,
}: Readonly<MoneyFieldProps>): React.JSX.Element {
  return (
    <div data-flash="" className={cn('rounded-[10px]', className)}>
      <Label htmlFor={id} className="mb-1.5 text-sm font-medium">
        {label}
      </Label>
      <div className="relative">
        <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
          A$
        </span>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          className={cn(
            'pl-9 font-mono tabular-nums',
            suffix !== undefined && 'pr-12',
            large && 'h-11 text-lg font-semibold'
          )}
          value={valueCents === null ? '' : centsToDollars(valueCents)}
          onChange={(e) => onChange(parseDollarsToCents(e.target.value))}
          placeholder={placeholder}
        />
        {suffix !== undefined && (
          <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm">
            {suffix}
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-1.5 text-[12.5px]">{help}</p>
    </div>
  );
}

/** Upper-case the first character, for a name that opens a sentence ("the client"). */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sumLine(sum: number): string {
  if (sum === 100) return 'Adds up to 100%';
  if (sum < 100) return `Adds up to ${sum}%. ${100 - sum}% left to assign.`;
  return `Adds up to ${sum}%. That's ${sum - 100}% over.`;
}

interface FixedPricingProps {
  state: ProposalDraftState;
  totalCents: number;
  onFixedPriceChange: (cents: number | null) => void;
  onInstallmentsChange: (next: ProposalInstallmentDraft[]) => void;
}

function FixedPricing({
  state,
  totalCents,
  onFixedPriceChange,
  onInstallmentsChange,
}: Readonly<FixedPricingProps>): React.JSX.Element {
  const { installments, currency } = state;
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (pendingFocusId === null) return;
    const target = document.getElementById(pendingFocusId);
    if (target === null) return;
    target.focus();
    setPendingFocusId(null);
  }, [pendingFocusId, installments]);

  const sum = installmentsSum(state);
  const activePreset = matchInstallmentPreset(state);

  const patchInstallment = useCallback(
    (index: number, partial: Partial<ProposalInstallmentDraft>): void => {
      onInstallmentsChange(
        installments.map((inst, i) => (i === index ? { ...inst, ...partial } : inst))
      );
    },
    [installments, onInstallmentsChange]
  );

  const removeInstallment = useCallback(
    (index: number): void => {
      onInstallmentsChange(installments.filter((_, i) => i !== index));
    },
    [installments, onInstallmentsChange]
  );

  const handlePct = useCallback(
    (index: number) =>
      (event: React.ChangeEvent<HTMLInputElement>): void => {
        const raw = event.target.value.trim();
        const parsed = raw === '' ? 0 : Number.parseInt(raw, 10);
        const clamped = Number.isNaN(parsed) ? 0 : Math.min(100, Math.max(0, parsed));
        patchInstallment(index, { pct: clamped });
      },
    [patchInstallment]
  );

  const applyPreset = useCallback(
    (key: InstallmentPresetKey): void => onInstallmentsChange(presetInstallments(key, state)),
    [onInstallmentsChange, state]
  );

  const addInstallment = useCallback((): void => {
    const row: ProposalInstallmentDraft = {
      key: nextDraftKey(),
      label: '',
      pct: Math.max(0, 100 - sum),
    };
    onInstallmentsChange([...installments, row]);
    setPendingFocusId(installmentFieldId('label', row.key));
  }, [installments, onInstallmentsChange, sum]);

  return (
    <>
      <MoneyField
        id={COMPOSER_TARGET.fixedPrice}
        label="Project price"
        help="The full amount you'll receive for this project."
        valueCents={state.fixedPriceCents}
        onChange={onFixedPriceChange}
        placeholder="15,000"
        large
        className="mb-5.5 max-w-[280px]"
      />

      <span className="mb-2 block text-sm font-medium">Payment schedule</span>
      <div role="group" aria-label="Payment presets" className="mb-3 flex flex-wrap gap-1.5">
        {INSTALLMENT_PRESETS.map((preset) => {
          const on = activePreset === preset.key;
          return (
            <button
              key={preset.key}
              type="button"
              aria-pressed={on}
              onClick={() => applyPreset(preset.key)}
              className={cn(
                'focus-visible:ring-ring min-h-11 rounded-full border px-3 text-[13.5px] transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-8',
                on
                  ? 'border-primary bg-primary/10 text-primary font-medium'
                  : 'border-border bg-card text-foreground hover:border-muted-foreground/40'
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {installments.length > 0 && (
        <ul className="border-border overflow-hidden rounded-[14px] border">
          {installments.map((inst, index) => {
            const n = index + 1;
            const amount = Math.round((totalCents * inst.pct) / 100);
            return (
              <li
                key={inst.key}
                data-flash=""
                className="group border-border bg-card flex flex-wrap items-center gap-2 border-b p-2 last:border-b-0"
              >
                <Input
                  id={installmentFieldId('label', inst.key)}
                  value={inst.label}
                  placeholder="Payment name"
                  aria-label={`Payment ${n} name`}
                  onChange={(e) => patchInstallment(index, { label: e.target.value })}
                  className="hover:bg-muted/60 focus-visible:bg-muted/60 min-w-40 flex-1 border-transparent bg-transparent text-[15px] shadow-none"
                />
                <div className="relative w-24 shrink-0">
                  <Input
                    id={installmentFieldId('pct', inst.key)}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    aria-label={`Payment ${n} percentage`}
                    className="pr-8 font-mono tabular-nums"
                    value={inst.pct}
                    onChange={handlePct(index)}
                  />
                  <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm">
                    %
                  </span>
                </div>
                <span className="text-muted-foreground w-24 shrink-0 text-right font-mono text-sm tabular-nums">
                  {totalCents > 0 ? formatWholeCurrency(amount, currency) : '—'}
                </span>
                <button
                  type="button"
                  onClick={() => removeInstallment(index)}
                  aria-label={`Remove payment ${n}`}
                  className="text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:ring-ring flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors group-focus-within:opacity-100 focus-visible:ring-2 focus-visible:outline-none sm:size-8 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-2.5">
        <button
          type="button"
          id={COMPOSER_TARGET.addInstallment}
          onClick={addInstallment}
          className="text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Plus className="size-4" aria-hidden="true" />
          Add payment
        </button>
        {installments.length > 0 && (
          <span
            role="status"
            className={cn(
              'inline-flex items-center gap-1.5 text-[13.5px]',
              sum === 100 ? 'text-success-strong' : 'text-warning-strong'
            )}
          >
            {sum === 100 && <Check className="size-3.5" aria-hidden="true" />}
            {sumLine(sum)}
          </span>
        )}
      </div>
    </>
  );
}

interface TimeAndMaterialsProps {
  state: ProposalDraftState;
  totalCents: number;
  onDepositChange: (cents: number | null) => void;
  onRateChange: (cents: number | null) => void;
  onCadenceChange: (cadence: ProposalCadenceValue) => void;
}

function TimeAndMaterials({
  state,
  totalCents,
  onDepositChange,
  onRateChange,
  onCadenceChange,
}: Readonly<TimeAndMaterialsProps>): React.JSX.Element {
  const { rateCents, currency } = state;
  const totalMinutes = sumEstimatedMinutes(state.milestones);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <MoneyField
          id={COMPOSER_TARGET.rate}
          label="Hourly rate"
          help="What you'll bill per hour on this proposal."
          valueCents={rateCents}
          onChange={onRateChange}
          suffix="/hr"
        />
        <MoneyField
          id={COMPOSER_TARGET.deposit}
          label="Deposit"
          help="Paid before work starts."
          valueCents={state.depositCents}
          onChange={onDepositChange}
        />
      </div>

      <div>
        <span id="proposal-cadence-label" className="mb-1.5 block text-sm font-medium">
          Invoices
        </span>
        <div
          role="group"
          aria-labelledby="proposal-cadence-label"
          className="bg-muted inline-flex gap-0.5 rounded-[10px] p-[3px]"
        >
          {CADENCE_OPTIONS.map((option) => {
            const on = state.cadence === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={on}
                onClick={() => onCadenceChange(option.value)}
                className={cn(
                  'focus-visible:ring-ring min-h-11 rounded-lg px-3.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-8',
                  on
                    ? 'bg-card text-foreground font-medium shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {rateCents === null || totalMinutes === 0 ? (
        <p className="text-muted-foreground border-border bg-muted/30 rounded-[10px] border px-3 py-2.5 text-[13px]">
          Set an hourly rate and per-milestone effort to see the total.
        </p>
      ) : (
        <div className="border-border bg-muted/30 flex flex-wrap items-center justify-between gap-2 rounded-[12px] border px-4 py-3">
          <div className="min-w-0">
            <span className="text-foreground text-sm font-medium">Estimated total</span>
            <p className="text-muted-foreground mt-0.5 text-[12px]">
              {minutesToHoursLabel(totalMinutes)}h at {formatWholeCurrency(rateCents, currency)}
              /hr — billed against actuals, not a cap.
            </p>
          </div>
          <span className="text-foreground font-mono text-sm font-semibold tabular-nums">
            ≈ {formatWholeCurrency(totalCents, currency)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Pricing section, adaptive to the method. Fixed ("Price and payments"): the
 * project price first, then payment-schedule presets and the editable instalment
 * rows with a live sum line. T&M ("Rates and billing"): rate, deposit, a segmented
 * invoice cadence and the derived estimate. Terms live in the property bar.
 */
export function PricingSection({
  state,
  totalCents,
  companyName,
  onFixedPriceChange,
  onInstallmentsChange,
  onDepositChange,
  onRateChange,
  onCadenceChange,
}: Readonly<PricingSectionProps>): React.JSX.Element {
  if (state.pricingMethod === 'fixed') {
    return (
      <ComposerSection
        id="proposal-section-pricing"
        title="Price and payments"
        help={`One price for the whole project, and how ${companyName} pays it.`}
      >
        <FixedPricing
          state={state}
          totalCents={totalCents}
          onFixedPriceChange={onFixedPriceChange}
          onInstallmentsChange={onInstallmentsChange}
        />
      </ComposerSection>
    );
  }
  return (
    <ComposerSection
      id="proposal-section-pricing"
      title="Rates and billing"
      help={`${capitalise(companyName)} is billed for time worked. Milestones are a guide, not a cap.`}
    >
      <TimeAndMaterials
        state={state}
        totalCents={totalCents}
        onDepositChange={onDepositChange}
        onRateChange={onRateChange}
        onCadenceChange={onCadenceChange}
      />
    </ComposerSection>
  );
}
