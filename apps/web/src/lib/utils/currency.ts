import { PLATFORM_PRICING } from '@/lib/constants/platform';

/** Convert cents (integer) to dollars (number). E.g. 200 => 2.00 */
export function centsToDollars(cents: number): number {
  return cents / 100;
}

/** Convert dollars (number) to cents (integer). E.g. 2.00 => 200 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Format cents as currency string. E.g. 200 => "A$2.00" */
export function formatCurrency(cents: number): string {
  const dollars = centsToDollars(cents);
  return `${PLATFORM_PRICING.CURRENCY_SYMBOL}${dollars.toFixed(2)}`;
}

/** Calculate client rate from expert rate (both in cents). */
export function calculateClientRate(expertRateCents: number): number {
  return Math.round(expertRateCents * PLATFORM_PRICING.MARKUP_MULTIPLIER);
}

/** Convert per-minute rate (cents) to per-hour rate (cents). */
export function perMinuteToPerHour(perMinuteCents: number): number {
  return perMinuteCents * 60;
}
