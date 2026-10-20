import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { TIERS_MINOR, formatAudShort } from '@/lib/credit/display-constants';

/**
 * The quick-pick amounts: the amount that makes the booking pass (chip 0, labelled "Minimum"),
 * then every standard tier above it. A tier at or below the minimum would not cover the booking,
 * so it is never offered.
 */
export function buildAmountChips(suggestedMinor: number): readonly number[] {
  return [suggestedMinor, ...TIERS_MINOR.filter((tier) => tier > suggestedMinor)];
}

export type OtherAmountResult =
  | { readonly ok: true; readonly amountMinor: number }
  | { readonly ok: false; readonly error: string };

/**
 * Parse the "Other" amount field (dollars, any decoration) into AUD minor units.
 *
 * Every character except digits and `.` is dropped, so `A$1,200` and `1200` read the same. The
 * checks run in the order a person fixes them: something typed, at least the minimum that makes
 * the booking pass, at most one top-up, and a whole step.
 */
export function parseOtherAmount(raw: string, minMinor: number): OtherAmountResult {
  const dollars = Number.parseFloat(raw.replaceAll(/[^0-9.]/g, ''));
  if (Number.isNaN(dollars)) return { ok: false, error: 'Enter an amount.' };

  const amountMinor = Math.round(dollars * 100);
  if (amountMinor < minMinor) {
    return { ok: false, error: `Enter at least ${formatAudShort(minMinor)}.` };
  }
  if (amountMinor > TOP_UP_LIMITS_MINOR.max) {
    return {
      ok: false,
      error: `One top-up can be up to ${formatAudShort(TOP_UP_LIMITS_MINOR.max)}.`,
    };
  }
  if (amountMinor % TOP_UP_LIMITS_MINOR.step !== 0) {
    return { ok: false, error: 'Use whole hundreds, like A$400.' };
  }
  return { ok: true, amountMinor };
}

/** The helper line under the "Other" field while it holds no error. */
export function otherAmountHint(minMinor: number): string {
  return `Between ${formatAudShort(minMinor)} and ${formatAudShort(TOP_UP_LIMITS_MINOR.max)}, in A$100 steps.`;
}
