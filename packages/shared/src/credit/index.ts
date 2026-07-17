/**
 * `@balo/shared/credit` — pure, dependency-free credit projections shared by apps/api
 * (the drawdown route) and apps/web (the in-session components). Kept off the pino-pulling
 * package root so it is safe for the client bundle.
 */
export {
  deriveDrawdownState,
  derivePromoRemainingMinor,
  type DrawdownState,
  type DrawdownInputs,
  type DrawdownKey,
  type DrawdownMeter,
  type DrawdownCta,
  type CreditSessionStatus,
  type PromoLedgerSums,
} from './drawdown-state';
export {
  isWalletMandateActive,
  toSettleableSession,
  type SettleableSession,
  type MandateWalletFields,
} from './settlement';
