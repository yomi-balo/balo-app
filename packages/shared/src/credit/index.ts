/**
 * `@balo/shared/credit` — pure, dependency-free credit projections shared by apps/api
 * (the drawdown route) and apps/web (the in-session components). Kept off the pino-pulling
 * package root so it is safe for the client bundle.
 */
export { type EligibleCompany } from './eligible-company';
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
  isWalletCardReusableOnSession,
  isCardBackedLowBalanceMode,
  isAbsentPaymentMethodId,
  walletAllowsOverdraftGrace,
  toSettleableSession,
  CARD_BACKED_LOW_BALANCE_MODES,
  type SettleableSession,
  type MandateWalletFields,
  type CardBackedLowBalanceMode,
  type CardBackedModeWriteGuard,
  type OverdraftGraceWalletFields,
} from './settlement';
export {
  resolveSettlementInstrument,
  type SettlementInstrument,
  type SettlementInstrumentSource,
  type ResolvedSettlementInstrument,
  type SettlementInstrumentCandidates,
} from './settlement-instrument';
export {
  resolveMeetingSettlement,
  clampedExpertPresentMs,
  type MeetingSettlementShape,
  type MeetingSettlementOutcome,
  type MeetingSettlementInput,
  type MeetingSettlement,
} from './meeting-settlement';
export { minutesOfRunway, type RunwayInputs } from './runway';
export {
  buildClientMoneyBlock,
  buildExpertMoneyBlock,
  buildAdminMoneyBlock,
  type MoneyBlockLens,
  type MoneyBlockState,
  type MoneyBlockFinalizationPath,
  type MoneyBlockPayoutStatus,
  // F17 — `MoneyBlockSettlementShape` is GONE. It was a second spelling of
  // `MeetingSettlementShape` (exported above, from `./meeting-settlement`); the money-block
  // payloads now reference that one type directly.
  type ClientMoneyBlock,
  type ExpertMoneyBlock,
  type AdminMoneyBlock,
  type SessionMoneyBlock,
  type ClientMoneyBlockInput,
  type ExpertMoneyBlockInput,
  type AdminMoneyBlockInput,
} from './money-block';
export { durationLine, finalizedAmountMinor } from './money-block-display';
export {
  type SessionStatementCounterparty,
  type ClientSessionStatementContext,
  type ExpertPayoutReference,
  type ExpertSessionStatementContext,
  type SessionStatement,
} from './session-statement';
