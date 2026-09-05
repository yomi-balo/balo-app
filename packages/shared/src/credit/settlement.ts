/**
 * BAL-378 (ADR-1040 Lane 2) — pure, dependency-free settlement helpers shared by apps/api
 * (`endSession` + the settlement webhook), apps/web (the drawdown read), and `@balo/db`
 * (the sessions repo). Extracted here as the single home so the mandate predicate + the
 * settleable-session narrowing never drift across surfaces (Sonar new-code duplication gate).
 * BAL-524 widens this file's scope by one clause: it is also the single home for "which
 * low-balance MODE needs a card" — consulted by the write guard (apps/web), the repository
 * write (`@balo/db`), and the card-removal reconcile, so that predicate cannot drift either.
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

/**
 * BAL-524 — which low-balance MODE needs a card, as opposed to which WALLET has one
 * ({@link isWalletCardReusableOnSession} above). Deliberately NOT folded into that predicate:
 * they answer different questions, and the `card-reuse.test.ts` anti-alignment posture applies
 * here too.
 *
 * The two card-backed modes: `auto_topup` reloads the wallet automatically, and `keep_going`
 * settles overdraft consultation time — both charge a card with nobody watching, so both
 * require one on file. `notify_only` charges nothing and is exempt.
 */

/** The two low-balance modes that CANNOT work without a card on file. */
export type CardBackedLowBalanceMode = 'auto_topup' | 'keep_going';

/** The set, as data — so a test can assert against it instead of restating it. */
export const CARD_BACKED_LOW_BALANCE_MODES: readonly CardBackedLowBalanceMode[] = [
  'auto_topup',
  'keep_going',
];

/**
 * Is this low-balance mode one that charges a card? ONE definition, consulted by the settings
 * write guard (apps/web), the repository write (@balo/db), and the card-removal reconcile — so
 * "card-backed" can never mean two different things at two ends of the same invariant.
 *
 * Generic in the input so it BOTH narrows a caller's own union (the settings section needs
 * `'auto_topup' | 'keep_going'` to index its mode-keyed copy) AND accepts
 * `CreditWallet['lowBalanceMode']` and the zod-inferred union without either package importing
 * the other's type. Structural, the same posture `MandateWalletFields` takes with
 * `mandateStatus: string | null`.
 */
export function isCardBackedLowBalanceMode<T extends string>(
  mode: T
): mode is T & CardBackedLowBalanceMode {
  return mode === 'auto_topup' || mode === 'keep_going';
}

/**
 * Whether a write that names a CARD-BACKED low-balance mode must prove a card is on file.
 * `'require_card_on_file'` is the DEFAULT at every seam that carries it — a caller that says
 * nothing is guarded. The exemption is spelled out, once, for the one operation that ESTABLISHES
 * the card in the same breath as the mode (a first purchase: the config is persisted before the
 * PaymentIntent, and the card lands later via the Stripe webhook).
 */
export type CardBackedModeWriteGuard =
  | 'require_card_on_file'
  | 'card_is_established_by_this_same_operation';

/**
 * BAL-524 (R4, external review) — does this `stripePaymentMethodId` value mean "no usable card"?
 * `null` is the documented explicit clear; `''` is defence-in-depth — no shipped caller sends it
 * today (a raw string column accepts it structurally), but a caller that treated `''` as
 * "present" would let a card-backed low-balance mode get WRITTEN while SQL's `isNotNull(...)`
 * WHERE then vouches for that same row on every later write. ONE definition, so the two TypeScript
 * spellings of the same fact can never disagree:
 *  · the Server Action guard, `apps/web/src/lib/credit/actions.ts`'s `saveLowBalanceConfigAction`
 *    — the friendly, named-control error, from the wallet already in hand; and
 *  · the repository write guard, `packages/db/src/repositories/credit-wallets.ts`'s
 *    `updateConfig` — the real invariant, a conditional `WHERE` that re-evaluates atomically.
 * SQL's `IS NOT NULL` arm is the one spelling this predicate cannot reach (SQL cannot call a TS
 * function); that gap is deliberate and already documented at its own call site — this predicate
 * only has to keep the two TS callers from drifting apart from EACH OTHER.
 *
 * `undefined` is a THIRD, separate case (the field was not mentioned in the write at all) — this
 * predicate answers only "is this a card-less VALUE", never "was this field supplied"; a caller
 * that must tell "not mentioned" apart from "explicitly absent" checks `=== undefined` itself
 * first (see `armsCardBackedModeGuard` in `credit-wallets.ts`).
 */
export function isAbsentPaymentMethodId(value: string | null | undefined): boolean {
  return value === null || value === '';
}
