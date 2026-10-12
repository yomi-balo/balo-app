/**
 * Platform-wide pricing configuration.
 * Markup is the percentage added to expert rates to produce client-facing rates.
 * All rate values throughout the system are stored in cents (integer).
 */
const MARKUP_MULTIPLIER = 1.25;

export const PLATFORM_PRICING = {
  /** Markup multiplier applied to expert rate to get client rate. 0.25 = 25% */
  MARKUP_PERCENTAGE: 0.25,
  /** Multiplier: clientRate = expertRate * MARKUP_MULTIPLIER */
  MARKUP_MULTIPLIER,
  /** Display label for the markup */
  MARKUP_LABEL: '25%',
  /** Balo's fee as a share of the CLIENT price (20%). Not the markup. */
  SERVICE_FEE_SHARE_LABEL: `${Math.round((1 - 1 / MARKUP_MULTIPLIER) * 100)}%`,
  /** Currency code */
  CURRENCY_CODE: 'AUD',
  /** Currency symbol prefix */
  CURRENCY_SYMBOL: 'A$',
  /** Minimum rate per minute in cents */
  MIN_RATE_CENTS: 0,
  /** Maximum rate per minute in cents ($50/min = 5000 cents) */
  MAX_RATE_CENTS: 5000,
  /** Maximum rate per minute in dollars (for display) */
  MAX_RATE_DOLLARS: 50,
} as const;
