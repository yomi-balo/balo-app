/**
 * Presentational country → tax-ID label map for the client billing-details form
 * (BAL-323). PURELY presentational: only the raw `taxId` string and the ISO
 * `countryCode` are persisted (see `company_billing_details`) — the field label
 * and placeholder are derived here, in the web app, never in @balo/db. No external
 * API is involved (Airwallex's dynamic schemas are payout/beneficiary-scoped and
 * do not model payer invoicing requirements).
 */

export interface BillingCountry {
  /** ISO 3166-1 alpha-2, uppercase (the persisted `countryCode`). */
  code: string;
  /** Display name shown in the country <Select>. */
  name: string;
}

/** The label + placeholder for the tax-ID field once a country is chosen. */
export interface TaxIdLabel {
  label: string;
  placeholder: string;
}

/**
 * Curated country list for the billing-details <Select>, sorted by display name.
 * The persisted value is the raw alpha-2 `code`; the tax-ID field label is derived
 * from it via {@link getTaxIdLabel}. Not an exhaustive ISO list — the markets Balo
 * invoices in, plus the major economies a client entity is likely to sit in (which
 * exercise the fallback label). Extend freely; it is presentational data.
 */
export const BILLING_COUNTRIES: readonly BillingCountry[] = [
  { code: 'AR', name: 'Argentina' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BR', name: 'Brazil' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'CA', name: 'Canada' },
  { code: 'CN', name: 'China' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DK', name: 'Denmark' },
  { code: 'EE', name: 'Estonia' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'HK', name: 'Hong Kong SAR' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IN', name: 'India' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IL', name: 'Israel' },
  { code: 'IT', name: 'Italy' },
  { code: 'JP', name: 'Japan' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'MT', name: 'Malta' },
  { code: 'MX', name: 'Mexico' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'NO', name: 'Norway' },
  { code: 'PH', name: 'Philippines' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RO', name: 'Romania' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'SG', name: 'Singapore' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'KR', name: 'South Korea' },
  { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'TH', name: 'Thailand' },
  { code: 'TR', name: 'Türkiye' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'VN', name: 'Vietnam' },
];

/**
 * The 27 EU member states share ONE bucket → "VAT Number". Deliberately a single
 * entry, not per-country local-language terms (per BAL-323): the persisted value
 * is the raw tax-ID string, so the label only needs to be right enough to prompt
 * the correct number.
 */
const EU_VAT_COUNTRIES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

/** Countries with their own named tax-ID scheme. Everything else → EU VAT or fallback. */
const NAMED_TAX_ID_LABELS: Readonly<Record<string, TaxIdLabel>> = {
  AU: { label: 'ABN', placeholder: 'e.g. 51 824 753 556' },
  NZ: { label: 'GST Number', placeholder: 'e.g. 123-456-789' },
  GB: { label: 'VAT Number', placeholder: 'e.g. GB123456789' },
  US: { label: 'EIN (Tax ID)', placeholder: 'e.g. 12-3456789' },
  CA: { label: 'Business Number (BN)', placeholder: 'e.g. 123456789 RT0001' },
  SG: { label: 'UEN', placeholder: 'e.g. 201812345A' },
};

const EU_VAT_LABEL: TaxIdLabel = { label: 'VAT Number', placeholder: 'e.g. DE123456789' };

/** Everything not named above and not in the EU VAT bucket. */
const FALLBACK_TAX_ID_LABEL: TaxIdLabel = {
  label: 'Tax ID / Business Registration Number',
  placeholder: 'Your business tax ID',
};

/**
 * The tax-ID field's label + placeholder for a given country. Case-insensitive on
 * the code; unknown / empty codes get the generic fallback. Pure + deterministic.
 */
export function getTaxIdLabel(countryCode: string): TaxIdLabel {
  const code = countryCode.trim().toUpperCase();
  const named = NAMED_TAX_ID_LABELS[code];
  if (named !== undefined) return named;
  if (EU_VAT_COUNTRIES.has(code)) return EU_VAT_LABEL;
  return FALLBACK_TAX_ID_LABEL;
}
