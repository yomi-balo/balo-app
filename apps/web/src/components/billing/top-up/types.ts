import type { LowBalanceMode } from '@/lib/credit/actions';
import type { DisplayCurrency } from '@/lib/credit/display-constants';

/**
 * The card on file, projected for DISPLAY. Never carries a Stripe id — the page-level
 * projection checks those and yields `null` when they are absent, because display columns
 * without a payment-method id describe a card nothing can actually charge.
 */
export interface SavedCard {
  /** Stripe's raw brand string, e.g. 'visa' — title-cased at render. */
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /**
   * Whether an ACTIVE off-session mandate backs this card. `false` means the card is on file
   * and chargeable ON-SESSION (the buyer is here, pressing Pay) but Balo may NOT charge it
   * unattended — picking a card-backed low-balance mode captures that consent separately.
   */
  mandateActive: boolean;
}

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
  /**
   * The card on file, or `null` for a first-time buyer. Replaces the write-only `hasCard`
   * boolean — ONE source of truth for "is there a card, and may Balo charge it unattended",
   * so the two answers can never disagree.
   */
  savedCard: SavedCard | null;
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

/**
 * Completion facts handed to the receipt (all client-observed; money lands via the webhook).
 * Lives here rather than beside the Pay button so the receipt and the charge orchestration can
 * import it without importing each other.
 */
export interface PurchaseCompletion {
  amountMinor: number;
  promoMinor: number;
  promoCode: string | null;
  lowBalanceMode: LowBalanceMode;
  mandateCaptured: boolean;
  /**
   * The PaymentIntent this purchase charged — the receipt's ONLY way to ask the wallet whether
   * the credit actually landed. The ledger is idempotent on exactly `manual_purchase:{piId}`, so
   * this id (not a balance delta, which a concurrent session drawdown would mask) is the
   * terminal condition of `use-topup-credit-poll`.
   *
   * ⚠ IT IS A QUESTION, NEVER A GRANT. Holding it authorises nothing: the read action scopes its
   * answer to the actor's own wallet, and the webhook remains the sole writer of credit.
   */
  paymentIntentId: string;
}
