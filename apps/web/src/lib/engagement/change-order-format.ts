import { formatWholeCurrency } from '@/lib/utils/currency';

const MINUS = '-';

/** Hours with at most one decimal: 3360 -> "56 hrs", 90 -> "1.5 hrs", 60 -> "1 hr". */
export function formatHours(minutes: number): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} ${Math.abs(hours) === 1 ? 'hr' : 'hrs'}`;
}

export function signedHours(minutes: number): string {
  if (minutes > 0) return `+${formatHours(minutes)}`;
  if (minutes < 0) return `${MINUS}${formatHours(-minutes)}`;
  return 'no change';
}

export function signedMoney(cents: number, currency: string): string {
  return cents > 0
    ? `+${formatWholeCurrency(cents, currency)}`
    : formatWholeCurrency(cents, currency);
}

/** The currency's symbol as the money figures render it ("A$" for AUD). */
export function currencySymbol(currency: string): string {
  const parts = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? currency.toUpperCase();
}
