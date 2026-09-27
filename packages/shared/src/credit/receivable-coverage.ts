/**
 * BAL-535 (ADR-1040 Amendment 6 §F) — the pure predicate behind "does the company's own CASH
 * cover its outstanding debt". `openReceivableAndDun` posts NO compensating ledger entry when it
 * opens a receivable, so the wallet's NEGATIVE BALANCE **is** the debt, and the receivable row is
 * only a parallel record of it. The receivable's own stored figure is a snapshot of what the
 * terminal overdraft WAS at open time; it diverges from what is actually owed the moment any
 * other ledger entry lands (a partial top-up, a promo grant, an expiry, a later session). Compare
 * a payment against that stale snapshot and you both over- and under-claim.
 *
 * ⚠⚠ THE PROMO DISCOUNT IS A REQUIRED ARGUMENT, AND THAT IS THE WHOLE POINT (fix round B1).
 * Amendment 6 §F originally claimed the promo exclusion was "structural rather than conditional"
 * because the call site read the balance as of the base credit, upstream of the bundled promo
 * grant. That claim was FALSE for every promo that landed in an EARLIER transaction — such a
 * grant is already inside the aggregate `balance_minor`, so a later one-cent cash top-up cleared
 * the whole receivable. It was false a second time at the two late-open (R3b) sites, which read
 * committed wallet state and therefore saw every promo adjustment ever made.
 *
 * The exclusion is made real HERE, in the signature: a caller cannot ask this question without
 * naming how much promo credit has landed since the debt became outstanding. The predicate stays
 * a LIVE BALANCE figure (never the receivable's stale `amount_minor`) — it simply discounts the
 * part of that balance a marketing grant paid for.
 *
 * ⚠ NOT A CARD-STATE PREDICATE — deliberately its OWN module, not a line inside `settlement.ts`.
 * `settlement.ts`'s own docblock bans widening `isWalletMandateActive` /
 * `isWalletCardReusableOnSession` into each other, and requires a further card predicate landing
 * there to justify itself (the `settlement-instrument.ts` precedent). This is not a predicate
 * over a wallet's card state at all — it is a statement about a BALANCE — so it gets its own file.
 *
 * ⚠⚠ THE SIGNATURE IS THE INVARIANT. This function takes ONLY balance figures — never the
 * receivable's amount. A caller literally cannot compare against the receivable's stale snapshot
 * without changing the signature, which
 * `packages/db/src/invariants/an-account-hold-outlives-only-an-unpaid-balance.test.ts`'s
 * anti-collapse assertions pin by checking the arity AND scanning this file for the receivable's
 * field names.
 */

/**
 * The CASH-funded credit reasons (ADR-1040 Amendment 6 §F) — the two top-up reasons, and the
 * derivation base of {@link DEBT_COVERING_CREDIT_REASONS}. `overdraft_settlement` is absent from
 * THIS list (it is not cash the client chose to add); it joins the debt-covering set below, which
 * is what arms the coverage clear since ADR-1040 Amendment 7 §F. `promo` is absent from both
 * because a marketing grant is not the client's money; the DISCOUNT in
 * `creditCoversOutstandingDebt` is what makes that exclusion real, not this list (a promo never
 * arrives as a Stripe credit effect in the first place).
 *
 * Lives HERE, next to the predicate, rather than in `apps/api` — `@balo/analytics` and
 * `@balo/shared/notifications` both need the derived union and neither may import from an app.
 */
export const CASH_CREDIT_REASONS = ['manual_purchase', 'auto_topup'] as const;

/** How an open receivable was covered — DERIVED from `CASH_CREDIT_REASONS`, never restated. */
export type CashCreditReason = (typeof CASH_CREDIT_REASONS)[number];

/**
 * BAL-474 (ADR-1040 Amendment 7 §F, plan AD-8) — the credit reasons that may END a company's soft
 * account hold: the cash set plus a session's own `overdraft_settlement` charge. DERIVED from
 * {@link CASH_CREDIT_REASONS} by spread, so a new cash reason can never be forgotten here.
 *
 * ⚠ WHY A SETTLEMENT CREDIT MAY NOW CLEAR AN OLDER RECEIVABLE (the share-bound proof). A session's
 * charge is its SHARE of the wallet's negative balance — `share ≤ ownConsumed` and
 * `share ≤ walletNegative` at its terminal (`resolveSessionOverdraftShare`). So the settlement
 * credit alone brings the wallet to zero or above only when OTHER credits (cash, discounted promo,
 * other sessions' settlement credits) have already paid every older debt; the settlement charge
 * itself never pays an older receivable. That depends on the `ownConsumed` cap — BAL-477 must keep
 * it. The coverage predicate (with its promo discount) is unchanged and still decides.
 */
export const DEBT_COVERING_CREDIT_REASONS = [
  ...CASH_CREDIT_REASONS,
  'overdraft_settlement',
] as const;

/** A credit reason that may end a hold — DERIVED from the list, never restated. */
export type DebtCoveringCreditReason = (typeof DEBT_COVERING_CREDIT_REASONS)[number];

/** Narrow an arbitrary credit reason to the debt-covering set — the reason gate for the clear. */
export function isDebtCoveringCreditReason(reason: string): reason is DebtCoveringCreditReason {
  return (DEBT_COVERING_CREDIT_REASONS as readonly string[]).includes(reason);
}

/**
 * Does the wallet's CASH cover its outstanding debt?
 *
 * @param balanceMinorAfterCredit the wallet's LIVE balance once this credit has been applied.
 * @param promoGrantedSinceDebtMinor the total promo credit (`entry_type='adjustment'`,
 *   `reason='promo'`) granted to this wallet since the debt became outstanding. Always `>= 0`.
 *
 * A marketing grant must never discharge a real receivable, so it is subtracted back out before
 * the comparison: the question is whether the client's own money returned them to zero.
 */
export function creditCoversOutstandingDebt(
  balanceMinorAfterCredit: number,
  promoGrantedSinceDebtMinor: number
): boolean {
  return balanceMinorAfterCredit - promoGrantedSinceDebtMinor >= 0;
}

/**
 * BAL-474 (ADR-1040 Amendment 7 §G; owner ruling D6.2, plan AD-12) — THE ONE DEFINITION of "the
 * top-up that clears the hold": the smallest cash credit after which
 * {@link creditCoversOutstandingDebt} is true. It is what the dunning notice and the booking
 * panels quote, so "a top-up of this or more clears it" is literally true:
 *
 *   covers(balance + needed, promo) is true;
 *   needed > 0 ⇒ covers(balance + needed − 1, promo) is false;
 *   needed === 0 ⇔ covers(balance, promo);   needed ≥ 0.
 *
 * (Pinned over a grid by `packages/db/src/invariants/dunning-states-the-top-up-that-clears-the-hold.test.ts`.)
 *
 * ⚠ A TOP-UP AMOUNT, NOT A DEBT. It is the predicate's shortfall — it includes the promo granted
 * since the debt became outstanding (which the predicate discounts), so it can exceed what is
 * owed; the copy says the rest stays in the balance. It does NOT net another session's in-flight
 * settlement (D6.2 defines the figure as the predicate's shortfall).
 */
export function amountNeededToClearHold(
  balanceMinor: number,
  promoGrantedSinceDebtMinor: number
): number {
  return Math.max(0, promoGrantedSinceDebtMinor - balanceMinor);
}

/**
 * BAL-474 (plan §G.1) — a wallet's soft-hold status and the top-up that clears it, from ONE
 * consistent read (`creditReceivablesRepository.readHoldStatus`). Consumed by the dunning claim,
 * the booking snapshot and the booking verdict.
 */
export interface HoldStatus {
  /** ≥ 1 open, non-deleted receivable on the wallet — the company's soft account hold. */
  readonly onHold: boolean;
  readonly openReceivableCount: number;
  /**
   * Any open receivable's reason is `settlement_requires_action` — a PAST fact ("a card
   * confirmation was requested when the charge was attempted"), true after any card swap.
   */
  readonly confirmationWasRequested: boolean;
  /** `credit_wallets.balance_minor` in the same snapshot. */
  readonly balanceMinor: number;
  /** Promo granted since the oldest open debt's anchor — 0 when not on hold. */
  readonly promoGrantedSinceDebtMinor: number;
  /** `amountNeededToClearHold(balance, promo)` — 0 when not on hold. */
  readonly amountToClearMinor: number;
}
