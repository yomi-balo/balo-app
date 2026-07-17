/**
 * BAL-380 (ADR-1040 Lane 3) — pure display formatters shared by the credit
 * dormancy/expiry email templates and their in-app factories. Defined ONCE here (not
 * inlined in each template file) to keep the balance/date formatting identical across
 * email + in-app and avoid Sonar new-code duplication. No money library — the codebase
 * inlines these (cf. `formatPriceCents` in `in-app-templates.ts`). Presentation only —
 * these NEVER touch balance/settlement math (invariant #8).
 */

/**
 * AUD minor units → the client-facing display string, e.g. `formatAudMinor(34700)` →
 * `'A$347.00'`. Always two fraction digits, thousands-grouped (en-GB). A non-finite
 * input degrades to `'A$0.00'` rather than rendering `NaN`.
 */
export function formatAudMinor(minor: number): string {
  const safe = Number.isFinite(minor) ? minor : 0;
  const amount = (safe / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `A$${amount}`;
}

/**
 * BAL-377 — presentment (card) minor units + a lowercase ISO-4217 code → a display string
 * for the receipt, e.g. `formatPresentmentMinor(4200, 'usd')` → `'USD 42.00'`. Two fraction
 * digits, thousands-grouped (en-GB), the code upper-cased. Presentation only — this is the
 * amount the client's CARD was billed (captured from Stripe), never a balance figure. A
 * non-finite amount degrades to `'0.00'` with the code.
 */
export function formatPresentmentMinor(minor: number, currency: string): string {
  const safe = Number.isFinite(minor) ? minor : 0;
  const amount = (safe / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const code = currency.length > 0 ? currency.toUpperCase() : '';
  return code ? `${code} ${amount}` : amount;
}

/**
 * ISO instant → long UTC date for email copy, e.g. `'2027-07-12T…'` → `'12 July 2027'`
 * (en-GB, UTC). An unparseable input degrades to `'the expiry date'`.
 */
export function formatExpiryDateLong(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'the expiry date';
  }
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * ISO instant → short UTC date for the denser in-app copy, e.g. `'12 Jul 2027'`
 * (en-GB, UTC). An unparseable input degrades to `'the expiry date'`.
 */
export function formatExpiryDateShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'the expiry date';
  }
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
