/**
 * BAL-377 — PRESENTATION-ONLY constants + helpers for the top-up composer (ADR-1040 Lane 1).
 *
 * ⚠️ NONE of these figures are ever used in balance / settlement / charge math. The wallet
 * is AUD-only and the authoritative amounts come from Stripe at settlement (captured by the
 * webhook). The A$3/min rate is a display AVERAGE for translating an amount into "hours of
 * expert time"; the real per-minute rate depends on the expert booked. This is a pure module
 * (no `@balo/db`, no server-only imports) so it is safe to import into client components.
 *
 * FEE NON-LEAK (BAL-357): a top-up buys AUD at FACE VALUE. The Balo fee (`balo_fee_bps`)
 * lives in the per-minute expert consume rate applied at CONSUME time — never at top-up. So
 * `RATE_PER_MIN_MINOR` is a presentation average, NOT the fee, and nothing here exposes it.
 */

/** A$3.00/min (= A$180/hr) — presentation average for the time estimate. NEVER the fee. */
export const RATE_PER_MIN_MINOR = 300;

/** Slider bounds + snap, in AUD minor units: A$300 … A$10,000, snapping to A$100. */
export const MIN_AMOUNT_MINOR = 30_000;
export const MAX_AMOUNT_MINOR = 1_000_000;
export const STEP_MINOR = 10_000;

/** The green "goal" mark (A$5,000) — a warm reward, never pressure. */
export const GOAL_AMOUNT_MINOR = 500_000;

/** Default pre-selected amount (A$1,000) — a healthy mid-tier (design LOCKED default). */
export const DEFAULT_AMOUNT_MINOR = 100_000;

/** Quick-pick tiers (A$300 / A$1,000 / A$5,000); the A$5,000 tier carries the goal styling. */
export const TIERS_MINOR = [30_000, 100_000, 500_000] as const;

/** Auto-top-up input bounds (AUD minor). "Add" ≥ "When below"; sensible caps (Open Q7). */
export const MIN_RELOAD_MINOR = 5_000; // A$50 floor
export const MAX_RELOAD_MINOR = 1_000_000; // A$10,000 ceiling (matches the slider max)
export const MAX_THRESHOLD_MINOR = 1_000_000; // A$10,000 ceiling
export const DEFAULT_RELOAD_MINOR = 30_000; // A$300
export const DEFAULT_THRESHOLD_MINOR = 5_000; // A$50

/** The low-balance mode ids (mirrors the Server Action enum; kept local so this pure module
 * never imports the `'use server'` actions file). */
export type LowBalanceModeId = 'auto_topup' | 'keep_going' | 'notify_only';

/** Field-level validation messages for the auto-top-up "Add" / "When below" inputs. */
export interface AutoTopupErrors {
  reload?: string;
  threshold?: string;
}

/**
 * Validate the auto-top-up "Add" (reload) and "When below" (threshold) inputs INLINE, so a bad
 * combo shows a field-level message under the offending input (not a mis-attributed "amount"
 * error under the Pay button) and Pay can be blocked until it is fixed. Only meaningful for
 * `auto_topup`; the other modes never carry these figures, so they always validate. Bounds
 * mirror the Server Action's Zod schema (min A$50 reload; reload ≥ threshold; ≤ A$10,000).
 */
export function autoTopupConfigErrors(
  mode: LowBalanceModeId,
  reloadMinor: number,
  thresholdMinor: number
): AutoTopupErrors {
  if (mode !== 'auto_topup') return {};
  const errors: AutoTopupErrors = {};
  if (!Number.isFinite(reloadMinor) || reloadMinor < MIN_RELOAD_MINOR) {
    errors.reload = `Minimum top-up is ${formatAudShort(MIN_RELOAD_MINOR)}.`;
  } else if (reloadMinor > MAX_RELOAD_MINOR) {
    errors.reload = `Keep the top-up at ${formatAudShort(MAX_RELOAD_MINOR)} or below.`;
  } else if (reloadMinor < thresholdMinor) {
    errors.reload = 'The top-up must be at least the "when below" amount.';
  }
  if (thresholdMinor > MAX_THRESHOLD_MINOR) {
    errors.threshold = `Keep the trigger at ${formatAudShort(MAX_THRESHOLD_MINOR)} or below.`;
  }
  return errors;
}

/** Whether the auto-top-up config is valid (no field errors) for the given mode + amounts. */
export function isAutoTopupConfigValid(
  mode: LowBalanceModeId,
  reloadMinor: number,
  thresholdMinor: number
): boolean {
  const errors = autoTopupConfigErrors(mode, reloadMinor, thresholdMinor);
  return errors.reload === undefined && errors.threshold === undefined;
}

/**
 * Minor AUD → "5 hr 33 min" of expert time at the A$3/min presentation average.
 * Presentation only — never feeds a charge or a balance.
 */
export function timeStr(minor: number): string {
  const mins = Math.round(minor / RATE_PER_MIN_MINOR);
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  if (hours <= 0) return `${remainder} min`;
  if (remainder === 0) return `${hours} hr`;
  return `${hours} hr ${remainder} min`;
}

/** Minor AUD → "A$1,000.00" (two fraction digits, en-AU thousands grouping). */
export function formatAud(minor: number): string {
  return `A$${(minor / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Minor AUD → "A$1,000" (whole dollars, for slider labels + tier buttons). */
export function formatAudShort(minor: number): string {
  return `A$${Math.round(minor / 100).toLocaleString('en-AU')}`;
}

/** The region-localised indicative currencies the display-FX supports (presentation only). */
export type DisplayCurrency = 'USD' | 'GBP' | 'EUR';

const CURRENCY_SYMBOL: Record<DisplayCurrency, string> = {
  USD: 'US$',
  GBP: '£',
  EUR: '€',
};

/**
 * Minor AUD × AUD→quote display rate → an INDICATIVE local-currency string ("≈ US$642").
 * Rounded to whole units — deliberately imprecise, since "the final amount is set at
 * payment." Presentation only; the FX rate is display-FX (never balance math), and a stale
 * or missing rate should cause the caller to omit this entirely.
 */
export function formatIndicative(
  minor: number,
  currency: DisplayCurrency,
  audToQuote: number
): string {
  const symbol = CURRENCY_SYMBOL[currency];
  return `${symbol}${Math.round((minor / 100) * audToQuote).toLocaleString('en-AU')}`;
}
