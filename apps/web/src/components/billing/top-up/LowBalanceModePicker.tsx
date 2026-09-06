'use client';

import { useCallback } from 'react';
import { Zap, Radio, Bell, Info, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatAudShort, type AutoTopupErrors } from '@/lib/credit/display-constants';
import { isCardBackedLowBalanceMode, type CardBackedLowBalanceMode } from '@balo/shared/credit';
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
  /**
   * BAL-535 fix round 2 (F3) — whether time used beyond the balance WILL in fact settle to a
   * card afterward, i.e. this wallet has a card on file AND a live off-session mandate
   * (`isWalletMandateActive`). Drives the `notify_only` settlement sentence and NOTHING else.
   *
   * ⚠⚠ A SECOND PROP, NOT A REUSE OF `cardAvailable` — the two answer different questions and
   * disagree on real wallets. `cardAvailable` is about mode ENABLEMENT ("may this client pick a
   * card-backed mode"), and the composer hard-codes it `true` because a first-time card is
   * captured inline at Pay. Selecting the settlement sentence on it therefore promised a
   * FIRST-TIME buyer — nobody's card, no mandate — that their overrun "still settles to the card
   * on file afterward", which is simply false at the moment they read it. Settlement is
   * `isWalletMandateActive`-gated (permanently, ADR-1040 Amendment 6 §A.1/§C), so that is the
   * fact this prop must carry, from the wallet, at both call sites.
   */
  readonly settlesToCardOnFile: boolean;
  /** Inline field-level validation messages for the auto-top-up "Add" / "When below" inputs. */
  readonly errors?: AutoTopupErrors;
  /**
   * "Visa •••• 4242" when the buyer is paying with a card already on file, so the consent note
   * names the exact card. `null` (the default) keeps the generic "this card" wording used when
   * the card is about to be entered and has no name yet.
   *
   * ⚠ THIS IS THE ONLY MANDATE DISCLOSURE IN THE COMPOSER. The prototype prints a second copy
   * under the payment method; consent is given HERE, where the mode is chosen, and two copies
   * would be duplication in both the UX and the Sonar sense.
   */
  readonly cardLabel?: string | null;
}

interface ModeOption {
  id: LowBalanceMode;
  icon: LucideIcon;
  title: string;
  cardBacked: boolean;
}

/**
 * BAL-516 FIX ROUND — exported (additive, one line) so `RemoveCardConfirm`'s removal-consequence
 * copy can DERIVE the two card-backed mode titles from this array instead of keeping a second,
 * hand-authored copy of the same strings (review IMPORTANT — two independent copies is how copy
 * drifts, not how it's prevented).
 *
 * `cardBacked` here stays a literal display flag (which radio to disable) — it is per-option
 * render data, not an invariant branch, so it is NOT derived from `isCardBackedLowBalanceMode`.
 * It is instead pinned against the shared `CARD_BACKED_LOW_BALANCE_MODES` set by a test
 * (`LowBalanceModePicker.test.tsx`), because a drift here would offer the client a mode the
 * server (BAL-524) now refuses.
 */
export const MODE_OPTIONS: readonly ModeOption[] = [
  { id: 'auto_topup', icon: Zap, title: 'Auto top-up', cardBacked: true },
  { id: 'keep_going', icon: Radio, title: 'Keep me going', cardBacked: true },
  { id: 'notify_only', icon: Bell, title: 'Just notify me', cardBacked: false },
];

/**
 * BAL-516 FIX ROUND — the two card-backed mode titles, DERIVED from `MODE_OPTIONS` rather than a
 * second hand-authored copy of the same strings. Originally lived in `remove-card-confirm.tsx`;
 * MOVED here for BAL-524 (its second consumer, `low-balance-section.tsx`'s refusal toast) because
 * this is the file where `MODE_OPTIONS` lives, so it is where a constant derived from it belongs
 * — a second hand-rolled derivation is exactly the drift the BAL-516 fix round called out. The
 * `?? mode` fallback only matters if `MODE_OPTIONS` ever drops one of these two ids entirely
 * (never expected — both are shipped, permanent modes); it is a defensive guard against an
 * indexed lookup returning `undefined` (`noUncheckedIndexedAccess` posture), not a real fallback
 * path.
 */
export const CARD_BACKED_MODE_TITLE: Record<CardBackedLowBalanceMode, string> = {
  auto_topup: MODE_OPTIONS.find((option) => option.id === 'auto_topup')?.title ?? 'auto_topup',
  keep_going: MODE_OPTIONS.find((option) => option.id === 'keep_going')?.title ?? 'keep_going',
};

/**
 * BAL-535 (ADR-1040 Amendment 6 §D) — the `notify_only` description, in three pieces so the two
 * arms cannot drift.
 *
 * ⚠⚠ THE NON-SETTLING ARM IS WHERE THE CONSEQUENCE IS WORST, and it used to say nothing (fix
 * round L3). `open()` admits on a funded estimate alone, a presence session posts every billable
 * minute past zero, settlement finds no mandate to charge — so the client is left owing money
 * AND soft-held, while the only sentence they read was "I'll top up myself." The two arms now
 * share `BEYOND_BALANCE` verbatim, so the load-bearing clause is one string and a future edit to
 * either arm cannot quietly leave the other saying less.
 *
 * ⚠ FIX ROUND 2 (F3) — THE ARMS ARE CHOSEN BY `settlesToCardOnFile`, NOT BY `cardAvailable`, and
 * this arm no longer says "with no card on file". It now covers BOTH ways settlement can fail to
 * reach a card — no card at all, and a card with no live off-session mandate — so naming only
 * the first would have been false in the second.
 *
 * Copy rules (CLAUDE.md): gender-neutral, warm, non-adversarial, no countdown — and the word
 * "overdraft" NEVER appears (pinned in six files). This arm states the consequence as a helpful
 * fact plus the way out, which §F now genuinely provides: a covering top-up clears the hold in
 * the same transaction as the credit.
 */
const NOTIFY_ONLY_LEAD = "Tell me when I'm running low — I'll top up myself.";
const BEYOND_BALANCE = 'Time you use beyond your balance still';
const NOTIFY_ONLY_SETTLES_TO_CARD = `${BEYOND_BALANCE} settles to the card on file afterward.`;
const NOTIFY_ONLY_SETTLES_ON_TOP_UP = `${BEYOND_BALANCE} needs settling — we'll pause new sessions until a top-up clears it.`;

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
 * mode. "Overdraft" never appears (the copy says "keep me going" / "settle afterward") — and
 * `notify_only`'s description states the settlement fact when settlement will really reach a
 * card (ADR-1040 Amendment 6 §D, BAL-535).
 *
 * ⚠⚠ FIX ROUND 2 (F3) — THE PREVIOUSLY-ACCEPTED IMPRECISION IS FIXED, NOT ACCEPTED. This
 * docblock used to record that a wallet with a card but no LIVE mandate was "told slightly more
 * than is true". That framing understated it: the composer hard-codes `cardAvailable = true`, so
 * the sentence was shown to FIRST-TIME buyers with no card and no mandate at all — a plain
 * falsehood at the moment they read it. Settlement now has its own prop, `settlesToCardOnFile`,
 * carrying the wallet's real mandate state; `cardAvailable` keeps its one job, mode ENABLEMENT.
 */
export function LowBalanceModePicker({
  mode,
  onModeChange,
  reloadMinor,
  thresholdMinor,
  onReloadChange,
  onThresholdChange,
  cardAvailable,
  settlesToCardOnFile,
  errors,
  cardLabel = null,
}: Readonly<LowBalanceModePickerProps>) {
  const describe = useCallback(
    (option: ModeOption): string => {
      switch (option.id) {
        case 'auto_topup':
          return `Add ${formatAudShort(reloadMinor)} whenever your balance drops below ${formatAudShort(thresholdMinor)}, and keep sessions going if it still runs out.`;
        case 'keep_going':
          return "Don't interrupt sessions — settle any extra time to your card afterward.";
        default:
          // BAL-535 (ADR-1040 Amendment 6 §D) — THE GAP. This was a complete sentence about what
          // the mode does with the part that costs money left out: settlement is mode-blind
          // (Amendment 6 §A.1/§C, permanent), so a `notify_only` client whose card carries a live
          // mandate is still charged for time delivered past zero.
          //
          // ⚠ FIX ROUND 2 (F3) — the arm is chosen by `settlesToCardOnFile`, NEVER by
          // `cardAvailable`. The latter is `true` unconditionally in the composer (a first-time
          // card is captured inline at Pay), so selecting on it promised settlement to a card
          // that did not exist. Both hosts now pass the wallet's real mandate state.
          return `${NOTIFY_ONLY_LEAD} ${settlesToCardOnFile ? NOTIFY_ONLY_SETTLES_TO_CARD : NOTIFY_ONLY_SETTLES_ON_TOP_UP}`;
      }
    },
    [reloadMinor, thresholdMinor, settlesToCardOnFile]
  );

  const cardBackedSelected = isCardBackedLowBalanceMode(mode);

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
            You&apos;re letting Balo charge {cardLabel ?? 'this card'} for consultation time beyond
            your balance and for automatic top-ups, per your settings above. Change or turn this off
            anytime.
          </span>
        </p>
      )}
    </div>
  );
}
