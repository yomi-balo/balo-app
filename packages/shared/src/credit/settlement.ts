/**
 * BAL-378 (ADR-1040 Lane 2) — pure, dependency-free settlement helpers shared by apps/api
 * (`endSession` + the settlement webhook), apps/web (the drawdown read), and `@balo/db`
 * (the sessions repo). Extracted here as the single home so the mandate predicate + the
 * settleable-session narrowing never drift across surfaces (Sonar new-code duplication gate).
 *
 * NO `@balo/db`, NO postgres, NO I/O — behind the `@balo/shared/credit` subpath so it is
 * safe wherever the pure drawdown projection is (never drags the postgres driver into a
 * client bundle).
 */

/** The minimal session shape the settlement notices + analytics carry (PII/fee-safe). */
export interface SettleableSession {
  id: string;
  companyId: string;
  walletId: string;
  expertProfileId: string;
  overdraftSettledMinor: number | null;
}

/**
 * Narrow a full session row to the {@link SettleableSession} the notices carry — structural,
 * so a full `@balo/db` `CreditSession` is assignable without importing the db type here.
 */
export function toSettleableSession(session: SettleableSession): SettleableSession {
  return {
    id: session.id,
    companyId: session.companyId,
    walletId: session.walletId,
    expertProfileId: session.expertProfileId,
    overdraftSettledMinor: session.overdraftSettledMinor,
  };
}

/** The mandate fields an off-session charge needs — narrowed structurally to stay db-free. */
export interface MandateWalletFields {
  mandateStatus: string | null;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
}

/** An active off-session mandate = status `active` AND a saved customer AND a payment method. */
export function isWalletMandateActive(wallet: MandateWalletFields): boolean {
  return (
    wallet.mandateStatus === 'active' &&
    wallet.stripeCustomerId !== null &&
    wallet.stripePaymentMethodId !== null
  );
}
