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
  creditCoversOutstandingDebt,
  CASH_CREDIT_REASONS,
  type CashCreditReason,
  // BAL-474 (ADR-1040 Amendment 7 §F/§G) — the debt-covering reason set that arms the coverage
  // clear, the ONE "top-up that clears the hold" figure, and the hold status it is read into.
  DEBT_COVERING_CREDIT_REASONS,
  isDebtCoveringCreditReason,
  amountNeededToClearHold,
  type DebtCoveringCreditReason,
  type HoldStatus,
} from './receivable-coverage';
// BAL-474 (ADR-1040 Amendment 7 §A) — THE ONE DEFINITION of a session's settled figure: its own
// share of the wallet's negative balance, never debt it did not incur.
export {
  resolveSessionOverdraftShare,
  type SessionOverdraftShareInput,
  type SessionOverdraftShare,
  type SessionOverdraftBasis,
} from './session-overdraft-share';
// BAL-474 (plan AD-5) — `credit_sessions.opened_by`'s vocabulary, pinned to the pgEnum.
export { CREDIT_SESSION_OPENED_BY, type CreditSessionOpenedByLabel } from './session-opened-by';
// BAL-474 (plan §I.3) — the ONE window estimator shared by admission, the terminal-path open and
// both booking funding checks (moved from `apps/api`'s `join-meeting.ts`).
export { estimatedMinutesForWindow } from './estimate-window';
// BAL-474 (ADR-1040 Amendment 7 §H) — the ONE booking funding verdict over ONE snapshot.
export {
  assessCaseBookingFunding,
  assessCardRemovalCoverage,
  estimateCaseBookingMinor,
  type BookingFundingSnapshot,
  type CardRemovalSnapshot,
  type CardRemovalCoverageVerdict,
  type ReservableCaseBooking,
  type CaseBookingFundingVerdict,
} from './booking-funding';
// BAL-474 (plan AD-16) — the ONE definition of a single top-up's limits.
export { TOP_UP_LIMITS_MINOR } from './top-up-limits';
// BAL-474 (D12.1c) — the ONE closed-case predicate (a closure voids a no-show, never an attended call).
export { caseClosedBeforeStart, caseClosureNames, type CaseClosureNames } from './case-closure';
export {
  resolveMeetingSettlement,
  clampedExpertPresentMs,
  billingBasisMs,
  type MeetingSettlementShape,
  type MeetingSettlementOutcome,
  type MeetingSettlementInput,
  type MeetingSettlement,
} from './meeting-settlement';
export { minutesOfRunway, type RunwayInputs } from './runway';
export { deriveSessionEstimate, type SessionEstimate } from './session-estimate';
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
export {
  durationLine,
  finalizedAmountMinor,
  type DurationLinePresence,
} from './money-block-display';
export {
  type SessionStatementCounterparty,
  type ClientSessionStatementContext,
  type ExpertPayoutReference,
  type ExpertSessionStatementContext,
  type SessionStatement,
} from './session-statement';
