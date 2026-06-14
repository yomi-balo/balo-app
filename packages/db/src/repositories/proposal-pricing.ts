/**
 * Proposal pricing derivation (BAL-294) — the SINGLE SOURCE OF TRUTH for the
 * Time & Materials total formula.
 *
 * A PURE, transport-agnostic module — NO `db` import, NO I/O, NO analytics. Same
 * "tiny standalone module" spirit as `installmentsSumTo100` in
 * `proposal-payment-installments.ts`. Defined ONCE here and imported by BOTH the
 * coherence guard (`proposal-coherence.ts`, the `tm_total_mismatch` clause) AND the
 * web composer state (`computeTotalCents` under `pricingMethod === 'tm'`), so the
 * read-only display the expert sees and the integrity check at submit/accept can
 * never drift.
 *
 * T&M total: `round(sum(estimated_minutes) / 60 × rate_cents)`. Minutes and cents
 * are integers (integer minor-unit convention); a `null`/absent effort counts as 0.
 * The deposit is NOT part of this formula — it is an independent T&M term.
 */

/**
 * Sum of present milestone effort, in minutes. A `null`/absent `estimatedMinutes`
 * counts as 0 (mirrors how the coherence guard sums present `valueCents`). The
 * caller is responsible for passing only LIVE milestones (soft-deleted rows must
 * never reach here).
 */
export function sumEstimatedMinutes(
  milestones: Array<{ estimatedMinutes: number | null }>
): number {
  return milestones.reduce((sum, m) => sum + (m.estimatedMinutes ?? 0), 0);
}

/**
 * Derived T&M total in integer cents: `round(totalMinutes / 60 × rateCents)`.
 * `rateCents` is the per-HOUR rate (integer minor units); `totalMinutes` is the
 * summed effort across milestones. Rounds half-away-from-zero to the nearest cent
 * (`Math.round`). Both inputs are expected non-negative; with `totalMinutes === 0`
 * or `rateCents === 0` the result is `0`.
 */
export function deriveTmTotalCents(totalMinutes: number, rateCents: number): number {
  return Math.round((totalMinutes / 60) * rateCents);
}
