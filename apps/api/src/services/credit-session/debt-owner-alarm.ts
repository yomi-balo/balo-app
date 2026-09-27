/**
 * BAL-474 (ADR-1040 Amendment 7 §A.1 property 4, D7.3) — THE OWNERLESS-DEBT ALARM.
 *
 * Session-scoped settlement bills only a session's OWN share of the wallet's negative balance
 * (`resolveSessionOverdraftShare`), so debt older than the session is left where it was — owned by
 * an open receivable or by another session's in-flight settlement. The terminal transaction checks,
 * under the wallet lock and after the session's own terminal UPDATE, that every unit of older debt
 * it leaves behind still has an owner (`readOwnerlessPriorDebt`) and returns the reading as
 * `overdraftBasis.ownerlessPriorDebtMinor`.
 *
 * THIS MODULE IS A PURE REPORTER — it performs NO database read. The check already ran inside the
 * transaction, where it was consistent; a second read out here would compare a stale figure with a
 * later one (R4-F2). It is called from `completePresenceSettlement`, `endSessionAsSystem` and
 * `endSession`, post-commit.
 *
 * The alarm catches "no owner" and "owners too small", not every mis-clear: comparing amounts cannot
 * see an ownerless slice hidden behind a larger, partly paid, still-open receivable. The coverage
 * clears themselves are guarded by their own invariants.
 */
import * as Sentry from '@sentry/node';
import type { SessionOverdraftBasis } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('credit-session');

/**
 * ⚠ PINNED VERBATIM by `debt-owner-alarm.test.ts` — an operator's monitor matches on this string.
 */
export const WALLET_DEBT_WITHOUT_OWNER_MSG =
  'Wallet carries debt that no open receivable and no in-flight settlement owns — a coverage clear or a settlement stamp has lost a debt (ADR-1040 Amendment 7 §A)';

/**
 * Report an ownerless prior debt. A no-op unless `basis.ownerlessPriorDebtMinor > 0` (or when the
 * arm was the idempotent re-end, whose `basis` is `null`).
 */
export function reportOwnerlessPriorDebt(input: {
  readonly sessionId: string;
  readonly walletId: string;
  readonly companyId: string;
  readonly basis: SessionOverdraftBasis | null | undefined;
}): void {
  const { basis } = input;
  if (basis === null || basis === undefined || basis.ownerlessPriorDebtMinor <= 0) {
    return;
  }

  const fields = {
    sessionId: input.sessionId,
    walletId: input.walletId,
    companyId: input.companyId,
    priorDebtLeftMinor: basis.priorDebtLeftMinor,
    ownerlessPriorDebtMinor: basis.ownerlessPriorDebtMinor,
  };
  log.error(fields, WALLET_DEBT_WITHOUT_OWNER_MSG);
  Sentry.captureException(new Error(WALLET_DEBT_WITHOUT_OWNER_MSG), { extra: fields });
}
