import { centsToDollars, formatWholeCurrency } from '@/lib/utils/currency';

/**
 * Format integer minutes as a decimal-hours STRING (the numeric part only — the
 * caller appends its own unit suffix, e.g. "h" or "hrs"). Trims a trailing `.0`.
 * E.g. 90 → "1.5", 60 → "1", 0 → "0". Shared by the milestones effort input and
 * the payment-terms derived-total note so the rounding stays in one place.
 */
export function minutesToHoursLabel(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
}

/**
 * Format a money figure exactly: whole-dollar amounts as `A$10,000`
 * (`formatWholeCurrency`), anything with cents as `A$10,000.50`. Use wherever a
 * sum, mismatch or "Set price to" figure is shown, so a rounded display never
 * hides a real difference.
 */
export function formatProposalAmount(cents: number, currency: string): string {
  if (cents % 100 === 0) {
    return formatWholeCurrency(cents, currency);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(centsToDollars(cents));
}
