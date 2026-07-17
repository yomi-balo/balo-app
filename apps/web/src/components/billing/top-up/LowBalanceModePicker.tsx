'use client';

import { useCallback } from 'react';
import { Zap, Radio, Bell, Info, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatAudShort, type AutoTopupErrors } from '@/lib/credit/display-constants';
import type { LowBalanceMode } from '@/lib/credit/actions';

interface LowBalanceModePickerProps {
  readonly mode: LowBalanceMode;
  readonly onModeChange: (mode: LowBalanceMode) => void;
  readonly reloadMinor: number;
  readonly thresholdMinor: number;
  readonly onReloadChange: (minor: number) => void;
  readonly onThresholdChange: (minor: number) => void;
  /**
   * Whether a card is (or will be) available to back the card-backed modes. Under Card
   * funding a first-time card is captured inline at Pay, so this is `true` in the composer;
   * on billing-settings with no saved card it is `false` and the two card-backed modes
   * disable with a warm "Add a card to use this".
   */
  readonly cardAvailable: boolean;
  /** Inline field-level validation messages for the auto-top-up "Add" / "When below" inputs. */
  readonly errors?: AutoTopupErrors;
}

interface ModeOption {
  id: LowBalanceMode;
  icon: LucideIcon;
  title: string;
  cardBacked: boolean;
}

const MODE_OPTIONS: readonly ModeOption[] = [
  { id: 'auto_topup', icon: Zap, title: 'Auto top-up', cardBacked: true },
  { id: 'keep_going', icon: Radio, title: 'Keep me going', cardBacked: true },
  { id: 'notify_only', icon: Bell, title: 'Just notify me', cardBacked: false },
];

function RadioDot({ on }: Readonly<{ on: boolean }>) {
  return (
    <span
      className={cn(
        'flex size-[18px] shrink-0 items-center justify-center rounded-full border-2',
        on ? 'border-primary bg-primary' : 'border-border bg-background'
      )}
      aria-hidden="true"
    >
      {on && <span className="size-1.5 rounded-full bg-white" />}
    </span>
  );
}

/** A$-prefixed decimal input for the auto-top-up "Add" / "When below" amounts. */
function AmountInput({
  id,
  label,
  minor,
  error,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  minor: number;
  error?: string;
  onChange: (minor: number) => void;
}>) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const dollars = parseFloat(e.target.value.replace(/[^0-9.]/g, '')) || 0;
      onChange(Math.round(dollars * 100));
    },
    [onChange]
  );
  const errorId = `${id}-error`;
  return (
    <div className="min-w-[120px] flex-1">
      <label
        htmlFor={id}
        className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase"
      >
        {label}
      </label>
      <div className="relative mt-1.5">
        <span
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold"
        >
          A$
        </span>
        <input
          id={id}
          inputMode="decimal"
          value={(minor / 100).toString()}
          onChange={handleChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            'bg-background text-foreground focus-visible:ring-ring w-full rounded-lg border py-2 pr-3 pl-8 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none',
            error ? 'border-destructive focus-visible:ring-destructive/40' : 'border-border'
          )}
        />
      </div>
      {error && (
        <p id={errorId} className="text-destructive mt-1 text-[11px] font-medium">
          {error}
        </p>
      )}
    </div>
  );
}

function ModeCard({
  option,
  selected,
  disabled,
  description,
  onSelect,
}: Readonly<{
  option: ModeOption;
  selected: boolean;
  disabled: boolean;
  description: string;
  onSelect: (mode: LowBalanceMode) => void;
}>) {
  const handleClick = useCallback(() => {
    if (!disabled) onSelect(option.id);
  }, [disabled, onSelect, option.id]);
  const Icon = option.icon;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      role="radio"
      aria-checked={selected}
      className={cn(
        'focus-visible:ring-ring w-full rounded-xl border p-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
        selected ? 'border-primary bg-primary/5' : 'border-border bg-card',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-accent/30'
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5">
          <RadioDot on={selected} />
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-1.5">
            <Icon
              className={cn('size-4', selected ? 'text-primary' : 'text-muted-foreground')}
              strokeWidth={2.3}
              aria-hidden="true"
            />
            <span className="text-foreground text-sm font-semibold">{option.title}</span>
          </div>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed font-medium">
            {description}
          </p>
          {disabled && (
            <span className="border-warning/40 bg-warning/10 text-warning mt-1.5 inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold">
              Add a card to use this
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * BAL-377 low-balance mode picker (shared with billing-settings). Three warm modes; "Keep me
 * going" / "Auto top-up" are card-backed and gate on `cardAvailable`. Auto top-up reveals the
 * "Add" / "When below" inputs; a mandate disclosure note appears under a selected card-backed
 * mode. "Overdraft" never appears (the copy says "keep me going" / "settle afterward").
 */
export function LowBalanceModePicker({
  mode,
  onModeChange,
  reloadMinor,
  thresholdMinor,
  onReloadChange,
  onThresholdChange,
  cardAvailable,
  errors,
}: Readonly<LowBalanceModePickerProps>) {
  const describe = useCallback(
    (option: ModeOption): string => {
      switch (option.id) {
        case 'auto_topup':
          return `Add ${formatAudShort(reloadMinor)} whenever your balance drops below ${formatAudShort(thresholdMinor)}.`;
        case 'keep_going':
          return "Don't interrupt sessions — settle any extra time to your card afterward.";
        default:
          return "Tell me when I'm running low. I'll top up myself.";
      }
    },
    [reloadMinor, thresholdMinor]
  );

  const cardBackedSelected = mode === 'auto_topup' || mode === 'keep_going';

  return (
    <div>
      <div className="text-foreground mb-2.5 text-sm font-semibold" id="low-balance-mode-label">
        When your balance runs low
      </div>
      <div
        className="flex flex-col gap-2.5"
        role="radiogroup"
        aria-labelledby="low-balance-mode-label"
      >
        {MODE_OPTIONS.map((option) => (
          <ModeCard
            key={option.id}
            option={option}
            selected={mode === option.id}
            disabled={option.cardBacked && !cardAvailable}
            description={describe(option)}
            onSelect={onModeChange}
          />
        ))}
      </div>

      {mode === 'auto_topup' && cardAvailable && (
        <div className="border-border bg-muted/30 mt-2.5 flex flex-wrap gap-2.5 rounded-xl border p-3">
          <AmountInput
            id="reload-amount"
            label="Add"
            minor={reloadMinor}
            error={errors?.reload}
            onChange={onReloadChange}
          />
          <AmountInput
            id="threshold-amount"
            label="When below"
            minor={thresholdMinor}
            error={errors?.threshold}
            onChange={onThresholdChange}
          />
        </div>
      )}

      {cardBackedSelected && cardAvailable && (
        <p className="text-muted-foreground mt-2.5 flex gap-2 text-[11px] leading-relaxed font-medium">
          <Info
            className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
            strokeWidth={2.2}
            aria-hidden="true"
          />
          <span>
            You&apos;re letting Balo charge this card for consultation time beyond your balance and
            for automatic top-ups, per your settings above. Change or turn this off anytime.
          </span>
        </p>
      )}
    </div>
  );
}
