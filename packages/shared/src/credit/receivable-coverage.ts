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
 * The CASH-funded credit reasons (ADR-1040 Amendment 6 §F). A credit under one of these that
 * leaves the wallet's cash-backed balance non-negative releases the company's soft account hold.
 * `overdraft_settlement` is deliberately absent — it already clears its own session's receivable
 * via `markSettlementSettled`. `promo` is absent because a marketing grant is not the client's
 * money; the DISCOUNT in `creditCoversOutstandingDebt` is what makes that exclusion real, not
 * this list (a promo never arrives as a Stripe credit effect in the first place).
 *
 * Lives HERE, next to the predicate, rather than in `apps/api` — `@balo/analytics` and
 * `@balo/shared/notifications` both need the derived union and neither may import from an app.
 */
export const CASH_CREDIT_REASONS = ['manual_purchase', 'auto_topup'] as const;

/** How an open receivable was covered — DERIVED from `CASH_CREDIT_REASONS`, never restated. */
export type CashCreditReason = (typeof CASH_CREDIT_REASONS)[number];

/** Narrow an arbitrary credit reason to the cash set — the reason gate for the R3 clear. */
export function isCashCreditReason(reason: string): reason is CashCreditReason {
  return (CASH_CREDIT_REASONS as readonly string[]).includes(reason);
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
