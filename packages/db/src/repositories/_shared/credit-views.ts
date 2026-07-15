import type { CreditWallet, CreditLedgerEntry } from '../../schema';

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
