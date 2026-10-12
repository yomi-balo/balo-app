import { DEFAULT_BALO_FEE_BPS } from '@balo/shared/pricing';

/**
 * Platform-wide pricing configuration.
 * Markup is the percentage added to expert rates to produce client-facing rates.
 * All rate values throughout the system are stored in cents (integer).
 */
export const PLATFORM_PRICING = {
  /** Markup multiplier applied to expert rate to get client rate. 0.25 = 25% */
  MARKUP_PERCENTAGE: 0.25,
  /** Multiplier: clientRate = expertRate * MARKUP_MULTIPLIER */
  MARKUP_MULTIPLIER: 1.25,
  /** Display label for the markup */
  MARKUP_LABEL: '25%',
  /**
   * Balo's fee as a share of the CLIENT price (20%), not the markup: the fee added on top
   * (DEFAULT_BALO_FEE_BPS) over the client price (10000 + bps), e.g. 2500 / 12500.
   */
  SERVICE_FEE_SHARE_LABEL: `${Math.round((DEFAULT_BALO_FEE_BPS / (10_000 + DEFAULT_BALO_FEE_BPS)) * 100)}%`,
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
