/**
 * The ONE definition of what an accepted proposal makes due before kickoff — the "Due now"
 * figure the client sees on the accept-confirm modal, and the amount the kickoff checklist's
 * upfront invoice is raised for. Here (not `apps/web`) because `@balo/db`'s kickoff approval
 * must apply the same rule when it decides whether an invoice step is required.
 *
 * Fixed: the first installment (by sort order) is due now — its `pct` of the total; with no
 * installments the whole total is. T&M: the deposit, or nothing when there is none. A result
 * of `0` means the deal has nothing due upfront, so kickoff needs no upfront invoice.
 *
 * PURE. No I/O.
 */
export interface UpfrontDueTerms {
  pricingMethod: 'fixed' | 'tm';
  priceCents: number;
  depositCents: number | null;
  /** Fixed-price installments in sort order. Ignored for T&M. */
  installments: readonly { pct: number }[];
}

export function upfrontDueCents(terms: UpfrontDueTerms): number {
  if (terms.pricingMethod === 'tm') return terms.depositCents ?? 0;
  const [first] = terms.installments;
  if (first === undefined) return terms.priceCents;
  return Math.round((terms.priceCents * first.pct) / 100);
}
