import {
  buildClientMoneyBlock,
  buildExpertMoneyBlock,
  buildAdminMoneyBlock,
  type ClientMoneyBlock,
  type ExpertMoneyBlock,
  type AdminMoneyBlock,
  type MoneyBlockPayoutStatus,
} from '@balo/shared/credit';
import type {
  CreditWallet,
  CreditLedgerEntry,
  CreditSession,
  ExpertPayoutRecordStatus,
} from '../../schema';

/**
 * Client-lens projections / mappers (BAL-376 / ADR-1040). PURE — no `db`, no I/O.
 *
 * These codify the fee-boundary hard invariant at the PROJECTION layer (Decision 4:
 * no RLS): a client-bound wallet/ledger read NEVER carries mandate secrets or any
 * margin/markup/fee/expert-quote figure. Invariant tests #1/#2/#8 assert against these
 * concrete functions, so they are MEANINGFUL (not vacuously green).
 */

/**
 * Explicit Drizzle `columns:` projection for any client-bound wallet read — an
 * allow-list, so `stripe_payment_method_id` / `mandate_ref` (the off-session mandate
 * secrets) are STRUCTURALLY excluded (memory `reference_drizzle_with_hydration_leaks_secrets`
 * — never `with:` full-row hydration). Invariant #1 asserts these secret keys are
 * absent from this set.
 */
export const CLIENT_WALLET_VIEW_COLUMNS = {
  id: true,
  companyId: true,
  balanceMinor: true,
  currency: true,
  expiresAt: true,
  lowBalanceMode: true,
  topupThresholdMinor: true,
  topupReloadMinor: true,
  overdraftCeilingMinor: true,
} as const;

/** The projected, PII-safe wallet shape a client surface may render + available balance. */
export interface ClientWalletView {
  id: string;
  companyId: string;
  balanceMinor: number;
  currency: string;
  expiresAt: Date | null;
  lowBalanceMode: CreditWallet['lowBalanceMode'];
  topupThresholdMinor: number;
  topupReloadMinor: number;
  overdraftCeilingMinor: number | null;
  availableMinor: number;
}

/**
 * Map a wallet row + its computed available balance to the client view. Typed to the
 * ALLOW-LIST keys only, so even a full `CreditWallet` (which carries the mandate
 * secrets) yields an output whose key set NEVER includes `stripePaymentMethodId` /
 * `mandateRef` (invariant #1).
 */
export function toClientWalletView(
  row: Pick<
    CreditWallet,
    | 'id'
    | 'companyId'
    | 'balanceMinor'
    | 'currency'
    | 'expiresAt'
    | 'lowBalanceMode'
    | 'topupThresholdMinor'
    | 'topupReloadMinor'
    | 'overdraftCeilingMinor'
  >,
  availableMinor: number
): ClientWalletView {
  return {
    id: row.id,
    companyId: row.companyId,
    balanceMinor: row.balanceMinor,
    currency: row.currency,
    expiresAt: row.expiresAt,
    lowBalanceMode: row.lowBalanceMode,
    topupThresholdMinor: row.topupThresholdMinor,
    topupReloadMinor: row.topupReloadMinor,
    overdraftCeilingMinor: row.overdraftCeilingMinor,
    availableMinor,
  };
}

/**
 * The ONLY balance-affecting figure of a ledger entry — used by `applyLedgerEntry` and
 * reconciliation. Returns `entry.amountMinor` REGARDLESS of charged_currency /
 * charged_amount_minor / fx_rate. This is the testable heart of invariant #8: the
 * display/record fields NEVER enter balance math.
 */
export function balanceContribution(
  entry: Pick<
    CreditLedgerEntry,
    'amountMinor' | 'chargedCurrency' | 'chargedAmountMinor' | 'fxRate'
  >
): number {
  return entry.amountMinor;
}

/**
 * A client billing-activity row. `charged_*` are surfaced ONLY under a clearly-labelled
 * `display` block (or null); the mapper carries NO `baloFeeBps`/`margin`/`markup`/
 * `expertQuote` keys and never joins engagement fee data (invariant #2).
 */
export interface LedgerActivityView {
  id: string;
  entryType: CreditLedgerEntry['entryType'];
  reason: CreditLedgerEntry['reason'];
  amountMinor: number;
  balanceAfterMinor: number;
  createdAt: Date;
  sessionId: string | null;
  /** DISPLAY-ONLY record of what a card was billed — never a balance figure. */
  display: { chargedCurrency: string; chargedAmountMinor: number; fxRate: string } | null;
}

/** Map a ledger entry to the client activity view (fee-boundary safe — invariant #2). */
export function toLedgerActivityView(entry: CreditLedgerEntry): LedgerActivityView {
  const display =
    entry.chargedCurrency !== null && entry.chargedAmountMinor !== null && entry.fxRate !== null
      ? {
          chargedCurrency: entry.chargedCurrency,
          chargedAmountMinor: entry.chargedAmountMinor,
          fxRate: entry.fxRate,
        }
      : null;

  return {
    id: entry.id,
    entryType: entry.entryType,
    reason: entry.reason,
    amountMinor: entry.amountMinor,
    balanceAfterMinor: entry.balanceAfterMinor,
    createdAt: entry.createdAt,
    sessionId: entry.sessionId,
    display,
  };
}

// ── Money-block lens projections (BAL-399) — fee-concealment core (ADR-1040 Decision 4) ──
//
// Three lens-typed projections on the audience axis (client / expert / admin). The allow-list
// IS the boundary (no RLS): a client-bound read STRUCTURALLY excludes the expert rate/accrual +
// fee; an expert-bound read STRUCTURALLY excludes the client rate + fee + margin + the client's
// overdraft charge; the admin lens alone reads the full row. The pure `@balo/shared/credit`
// builders derive the display figures + enforce the pending/finalized discriminant, so the
// invariant tests (#1–#5) assert against these concrete functions — MEANINGFUL, not vacuous.

/**
 * CLIENT money-block projection allow-list. Structurally excludes `expertRateMinorPerHour` /
 * `expertRateMinorPerMinute` / `expertAccruedMinor` (raw expert economics), `baloFeeBps` (the
 * fee), and `stripePaymentIntentId` (reconciliation). `overdraftSettledMinor` is the client's
 * OWN card charge (client-safe). All timing/status columns are fee-safe (drive the fragment).
 */
export const CLIENT_SESSION_MONEY_COLUMNS = {
  id: true,
  status: true,
  settlementStatus: true,
  connectedMinutes: true,
  clientRateMinorPerMinute: true,
  connectedAt: true,
  endedAt: true,
  wrappedAt: true,
  graceEnteredAt: true,
  overdraftSettledMinor: true,
  durationSource: true,
  billingFinalizedAt: true,
  finalizationPath: true,
} as const;

/**
 * EXPERT money-block projection allow-list. Reads EXACTLY the columns the client view excludes
 * (`expertRateMinorPerMinute` → `expertAccruedMinor`). Structurally excludes `clientRate*`,
 * `baloFeeBps` (margin), `overdraftSettledMinor` (the client's charge), and `stripePaymentIntentId`.
 */
export const EXPERT_SESSION_MONEY_COLUMNS = {
  id: true,
  status: true,
  connectedMinutes: true,
  expertRateMinorPerMinute: true,
  expertAccruedMinor: true,
  connectedAt: true,
  endedAt: true,
  durationSource: true,
  billingFinalizedAt: true,
  finalizationPath: true,
} as const;

/** The projected, fee-safe session shape a CLIENT money-block surface may read. */
export type ClientSessionMoneyView = Pick<CreditSession, keyof typeof CLIENT_SESSION_MONEY_COLUMNS>;
/** The projected, own-economics session shape an EXPERT money-block surface may read. */
export type ExpertSessionMoneyView = Pick<CreditSession, keyof typeof EXPERT_SESSION_MONEY_COLUMNS>;

/**
 * Map a CLIENT-projected session row → the client money block. Typed to the ALLOW-LIST keys, so
 * even a full `CreditSession` (which carries the expert rate/accrual + fee) yields an output that
 * NEVER references them — the all-in charge only (invariant #1).
 */
export function toClientMoneyBlock(row: ClientSessionMoneyView): ClientMoneyBlock {
  return buildClientMoneyBlock({
    sessionId: row.id,
    connectedMinutes: row.connectedMinutes,
    clientRateMinorPerMinute: row.clientRateMinorPerMinute,
    settlementStatus: row.settlementStatus,
    billingFinalizedAt: row.billingFinalizedAt,
    finalizationPath: row.finalizationPath,
  });
}

/**
 * Map an EXPERT-projected session row (+ the payout obligation's status, if booked) → the expert
 * money block. Own earnings only — NEVER the client rate/charge, fee, margin, or overdraft
 * (invariant #2). `payoutStatus` is threaded from `expert_payout_records`, never a session column.
 */
export function toExpertMoneyBlock(
  row: ExpertSessionMoneyView,
  payoutStatus?: ExpertPayoutRecordStatus
): ExpertMoneyBlock {
  return buildExpertMoneyBlock({
    sessionId: row.id,
    connectedMinutes: row.connectedMinutes,
    expertAccruedMinor: row.expertAccruedMinor,
    billingFinalizedAt: row.billingFinalizedAt,
    finalizationPath: row.finalizationPath,
    ...(payoutStatus === undefined ? {} : { payoutStatus: payoutStatus as MoneyBlockPayoutStatus }),
  });
}

/**
 * Map a FULL session row → the admin money block — the SOLE margin-bearing lens. Margin is
 * `clientCharge − expertEarnings` from the immutable snapshots (invariant #3 positive assertion).
 */
export function toAdminMoneyBlock(row: CreditSession): AdminMoneyBlock {
  return buildAdminMoneyBlock({
    sessionId: row.id,
    connectedMinutes: row.connectedMinutes,
    clientRateMinorPerMinute: row.clientRateMinorPerMinute,
    expertAccruedMinor: row.expertAccruedMinor,
    baloFeeBps: row.baloFeeBps,
    overdraftSettledMinor: row.overdraftSettledMinor ?? 0,
    billingFinalizedAt: row.billingFinalizedAt,
    finalizationPath: row.finalizationPath,
  });
}
