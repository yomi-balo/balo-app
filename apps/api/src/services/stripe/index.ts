/**
 * Public provider surface for the Stripe credit layer (BAL-382). The consumer lanes
 * (BAL-377 purchase, BAL-378 settlement, BAL-379 auto-top-up, BAL-383 promo-continue)
 * import from here + from `@balo/db` (`deriveIdempotencyKey`, `applyLedgerEntry`); none
 * re-implement charge/mandate/webhook logic.
 */
export {
  ensureCustomer,
  attachPaymentMethod,
  createSetupIntent,
  retrieveCardDisplay,
  confirmSavedCardMandate,
  type SavedCardMandateResult,
} from './mandate.js';
export {
  createOnSessionPurchaseIntent,
  createOnSessionSavedCardCharge,
  createOffSessionCharge,
  retrieveSettlement,
  retrievePaymentIntentStatus,
  type PaymentIntentStatusResult,
  type SavedCardChargeResult,
} from './charges.js';
export {
  resolveStripeEffect,
  applyStripeEffect,
  applyOverdraftSettlementFromStripe,
} from './dispatch.js';
export { StripeConfigError } from './errors.js';
export type {
  SettlementFields,
  OffSessionChargeResult,
  StripeEffect,
  CreditTopupReceipt,
  CardDisplayFields,
  CardOnFileFields,
} from './types.js';
