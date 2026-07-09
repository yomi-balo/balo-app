/**
 * Proposal pricing derivation (BAL-294) — the SINGLE SOURCE OF TRUTH for the
 * Time & Materials total formula.
 *
 * A PURE, transport-agnostic module — NO `db` import, NO I/O, NO analytics. It lives
 * in `@balo/shared` (behind the `@balo/shared/pricing` subpath export, NOT the
 * package root which pulls in pino) precisely so it can be imported by BOTH the
 * server-side coherence guard (`@balo/db` `proposal-coherence.ts`, the
 * `tm_total_mismatch` clause) AND the browser-side web composer
 * (`computeTotalCents` under `pricingMethod === 'tm'`) without dragging the
 * postgres driver into the client bundle. The read-only display the expert sees and
 * the integrity check at submit/accept can never drift.
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

/** Default Balo service margin, in basis points (2500 bps = 25%). */
export const DEFAULT_BALO_FEE_BPS = 2500;

/** Lowest storable Balo fee, in basis points (0%). Mirrors the DB CHECK lower bound. */
export const MIN_BALO_FEE_BPS = 0;

/** Highest storable Balo fee, in basis points (100%). Mirrors the DB CHECK upper bound. */
export const MAX_BALO_FEE_BPS = 10_000;

/** A basis-point fee rate → its percent NUMBER, e.g. `1750 → 17.5`. */
export function feeBpsToPercent(bps: number): number {
  return bps / 100;
}

/**
 * A basis-point fee rate → its display string, e.g. `2500 → "25%"`. Promoted
 * verbatim from `submitted-view.tsx` so the expert/admin disclosure and the admin
 * override control render the fee identically (single source of truth).
 */
export function formatFeePercent(bps: number): string {
  return `${feeBpsToPercent(bps)}%`;
}

/**
 * Integer + within the DB CHECK range `[MIN_BALO_FEE_BPS, MAX_BALO_FEE_BPS]`. The
 * single "is this a storable bps" predicate — the server Zod range and the DB
 * CHECK both reference the same bounds, so validation can never drift.
 */
export function isValidBaloFeeBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= MIN_BALO_FEE_BPS && bps <= MAX_BALO_FEE_BPS;
}

export type ParseFeeResult =
  | { ok: true; bps: number }
  | { ok: false; reason: 'empty' | 'not_a_number' | 'too_many_decimals' | 'out_of_range' };

/**
 * Parse an admin-typed PERCENT string → integer bps, validating identically to the
 * DB CHECK. Tolerates surrounding whitespace and a single optional trailing `%`.
 * Allows at most 2 decimal places (2dp percent = whole bps); a 3rd+ decimal is
 * rejected as `too_many_decimals` rather than silently rounded, since fractional
 * bps can't be stored. `bps = Math.round(pct * 100)` (guards float dust); the
 * result must land in `[MIN_BALO_FEE_BPS, MAX_BALO_FEE_BPS]`.
 */
export function parseFeePercentToBps(input: string): ParseFeeResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  // Strip a single optional trailing percent sign, then re-trim ("17.5 %" → "17.5").
  const withoutPercent = (trimmed.endsWith('%') ? trimmed.slice(0, -1) : trimmed).trim();
  if (withoutPercent.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  // Anchored, non-ambiguous numeric shape (linear — no ReDoS): optional sign,
  // whole digits, optional single fractional group.
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(withoutPercent);
  if (match === null) {
    return { ok: false, reason: 'not_a_number' };
  }

  const fraction = match[2];
  if (fraction !== undefined && fraction.length > 2) {
    return { ok: false, reason: 'too_many_decimals' };
  }

  const bps = Math.round(Number(withoutPercent) * 100);
  if (bps < MIN_BALO_FEE_BPS || bps > MAX_BALO_FEE_BPS) {
    return { ok: false, reason: 'out_of_range' };
  }

  return { ok: true, bps };
}

/**
 * Gross a client-facing cents figure UP by the Balo fee.
 * clientCents = round(baseCents * (10000 + feeBps) / 10000).
 * Pure, integer-cents, Math.round (half-away-from-zero) — same convention as
 * deriveTmTotalCents. Never mutates the expert's stored quote.
 */
export function applyBaloFee(cents: number, feeBps: number): number {
  return Math.round((cents * (10_000 + feeBps)) / 10_000);
}
