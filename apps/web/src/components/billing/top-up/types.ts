import type { LowBalanceMode } from '@/lib/credit/actions';
import type { DisplayCurrency } from '@/lib/credit/display-constants';

/**
 * Serialisable wallet snapshot passed from the Server Component to the client composer.
 * Only the projected fields the UI needs — NEVER the full wallet row (no Stripe customer /
 * payment-method / mandate-ref secrets reach the client bundle).
 */
export interface WalletSnapshot {
  /**
   * `null` until the company's `credit_wallets` row exists. A company that has never held
   * credit has no row — the composer still renders (against the defaults the row will be
   * created with) and the first purchase materialises it via `ensureForCompany`.
   */
  walletId: string | null;
  balanceMinor: number;
  lowBalanceMode: LowBalanceMode;
  /** Whether an ACTIVE off-session mandate already exists (a card is on file). */
  hasCard: boolean;
  topupReloadMinor: number;
  topupThresholdMinor: number;
}

/**
 * Presentation-only display-FX snapshot (AUD→quote), region-localised. Omitted entirely
 * when the rate is missing or stale — the "≈ local currency" line simply disappears and the
 * AUD + time figures are unaffected (never depend on FX).
 */
export interface DisplayFxSnapshot {
  currency: DisplayCurrency;
  /** AUD→quote rate (multiply an AUD amount by this to get the indicative local figure). */
  audToQuote: number;
}

export type FundingMethod = 'card' | 'invoice';
