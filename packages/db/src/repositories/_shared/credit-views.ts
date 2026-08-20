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
 *
 * ⚠ BAL-412 ADDED THE THREE SETTLEMENT-PROVENANCE COLUMNS TO **BOTH** LENSES, IDENTICALLY.
 * `actualMinutes` / `billingFloorMinutes` / `settlementShape` are DURATIONS AND LABELS, never
 * figures — "6 minutes delivered, billed at the 15-minute minimum" is a fact both parties are
 * entitled to, and neither can difference it into a rate, a margin or the fee. Concealment of
 * FIGURES is unchanged: no expert rate/accrual crosses to a client, and no client
 * rate/charge/overdraft crosses to an expert.
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
  // BAL-412 — the actual-vs-billed split + how the settlement resolved. NULL on every row
  // written before migration 0071, so shipped receipts are unchanged.
  actualMinutes: true,
  billingFloorMinutes: true,
  settlementShape: true,
  // BAL-412 (R2/F14) — the SNAPSHOTTED floor verdict, so the recap agrees with the audit row and
  // the `floored:` metric instead of re-deriving `billable > actual` (which mislabels a Q1
  // no-refund clamp). A BOOLEAN, never a figure — nothing about the rate, fee or margin crosses.
  floorApplied: true,
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
  // BAL-412 — identical to the client lens (see that allow-list): durations and a label, so
  // the expert's own recap can say "you held 15 minutes; the client no-showed" without any
  // client figure crossing.
  actualMinutes: true,
  billingFloorMinutes: true,
  settlementShape: true,
  // BAL-412 (R2/F14) — identical to the client lens: the snapshotted boolean, never a figure.
  floorApplied: true,
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
    // BAL-412 — legacy-safe fallbacks. `actualMinutes` is NULL on every row written before
    // migration 0071 (and on every `live_capture`/`external` session): a session's "actual"
    // duration IS its connected minutes when it was never presence-settled. `0`/absent
    // otherwise — zero behaviour change for shipped rows (asserted by a test).
    actualMinutes: row.actualMinutes ?? row.connectedMinutes,
    billingFloorMinutes: row.billingFloorMinutes ?? 0,
    settlementShape: row.settlementShape,
    // BAL-412 (R2/F14) — the persisted verdict, NOT `billable > actual`. NULL on every legacy /
    // non-presence row ⇒ `false`, which is exactly right: no floor was ever in force there.
    floorApplied: row.floorApplied ?? false,
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
    // BAL-412 — see `toClientMoneyBlock`'s docblock for the legacy-safe fallback reasoning.
    actualMinutes: row.actualMinutes ?? row.connectedMinutes,
    billingFloorMinutes: row.billingFloorMinutes ?? 0,
    settlementShape: row.settlementShape,
    // BAL-412 (R2/F14) — see `toClientMoneyBlock`.
    floorApplied: row.floorApplied ?? false,
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
    // BAL-412 — see `toClientMoneyBlock`'s docblock for the legacy-safe fallback reasoning.
    actualMinutes: row.actualMinutes ?? row.connectedMinutes,
    billingFloorMinutes: row.billingFloorMinutes ?? 0,
    settlementShape: row.settlementShape,
    // BAL-412 (R2/F14) — see `toClientMoneyBlock`.
    floorApplied: row.floorApplied ?? false,
  });
}
