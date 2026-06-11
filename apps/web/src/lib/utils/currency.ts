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

/**
 * Format integer minor units as a grouped WHOLE-dollar string, e.g.
 * `A$78,000` (thousands separators, no cents). Use for displayed proposal
 * prices (summary total/estimate, payment-terms total + derived installment
 * amounts, the mobile summary bar) — the prices are large, so the cents-bearing
 * {@link formatCurrency} (`A$78000.00`) reads poorly. Mirrors
 * {@link formatBudgetRange}'s `Intl.NumberFormat` config (`en-US` so AUD renders
 * as `A$`, `maximumFractionDigits: 0`).
 */
export function formatWholeCurrency(cents: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  });
  return formatter.format(centsToDollars(cents));
}

/** Calculate client rate from expert rate (both in cents). */
export function calculateClientRate(expertRateCents: number): number {
  return Math.round(expertRateCents * PLATFORM_PRICING.MARKUP_MULTIPLIER);
}

/** Convert per-minute rate (cents) to per-hour rate (cents). */
export function perMinuteToPerHour(perMinuteCents: number): number {
  return perMinuteCents * 60;
}

/**
 * Format a budget range (integer minor units) as a grouped whole-dollar display
 * string, e.g. `A$45,000 – A$70,000`. Distinct from {@link formatCurrency}
 * (line-item, two-decimal): budgets are coarse ranges so we drop cents
 * (`maximumFractionDigits: 0`).
 *
 *  - both present, distinct → `"A$45,000 – A$70,000"` (en-dash)
 *  - both present, equal    → `"A$45,000"`
 *  - min only               → `"From A$45,000"`
 *  - max only               → `"Up to A$70,000"`
 *  - both null              → `null` (caller renders nothing)
 */
export function formatBudgetRange(
  minCents: number | null,
  maxCents: number | null,
  currency: string
): string | null {
  if (minCents === null && maxCents === null) return null;

  // `en-US` disambiguates AUD as `A$` (matching the platform symbol + the
  // prototype) while still rendering correct symbols for other currencies.
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  });
  const amount = (cents: number): string => formatter.format(centsToDollars(cents));

  if (minCents !== null && maxCents !== null) {
    if (minCents === maxCents) return amount(minCents);
    return `${amount(minCents)} – ${amount(maxCents)}`;
  }
  if (minCents !== null) return `From ${amount(minCents)}`;
  // Only maxCents is set here (both-null already returned above). Narrow by
  // control flow rather than asserting, so the type stays sound.
  if (maxCents !== null) return `Up to ${amount(maxCents)}`;
  return null; // unreachable — both-null returned at the top — but keeps the type.
}
