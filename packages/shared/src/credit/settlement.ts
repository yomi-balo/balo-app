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

/**
 * Whether a stored card may be charged ON-SESSION — the buyer is present and has just pressed
 * Pay. Requires a Stripe customer AND a saved payment method; deliberately does NOT require
 * `mandate_status === 'active'`.
 *
 * ⚠ THE TWO PREDICATES ARE NOT INTERCHANGEABLE and the difference is a consent boundary, not an
 * optimisation. `isWalletMandateActive` gates charges Balo initiates while nobody is watching
 * (auto-top-up, overdraft settlement); that consent is captured by an explicit off-session
 * SetupIntent. THIS predicate gates a charge the buyer is initiating right now against a card
 * they already gave us. Never widen one into the other — `card-reuse.test.ts` pins both side by
 * side over one table of wallet states so an "alignment" refactor fails loudly.
 *
 * Like `isWalletMandateActive` this returns a BOOLEAN and does NOT narrow the two nullable id
 * fields; a caller that needs the ids must null-check them itself (the shape `auto-topup.ts`
 * already uses).
 */
export function isWalletCardReusableOnSession(wallet: MandateWalletFields): boolean {
  return wallet.stripeCustomerId !== null && wallet.stripePaymentMethodId !== null;
}
