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

  // Anchored, non-ambiguous numeric shape (linear — no ReDoS): whole digits,
  // optional single fractional group; a leading sign is rejected (a fee percent
  // is never negative, so any leading minus fails to match → not_a_number).
  const match = /^(\d+)(?:\.(\d+))?$/.exec(withoutPercent);
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

// ── Client Credit System platform-money constants (BAL-376 / ADR-1040) ────
//
// No platform-config table exists, so these live as code constants alongside
// DEFAULT_BALO_FEE_BPS (pure, reachable everywhere — `@balo/db` `credit-ledger.ts`
// imports WALLET_EXPIRY_MONTHS; the driving lanes read the top-up/overdraft defaults).

/**
 * Platform default overdraft ceiling (AUD 150 = 15000 minor). A wallet whose
 * `overdraft_ceiling_minor` is NULL reads `?? DEFAULT_OVERDRAFT_CEILING_MINOR` at the
 * (later-lane) overdraft check.
 */
export const DEFAULT_OVERDRAFT_CEILING_MINOR = 15000;

/** Default auto-top-up threshold (AUD 20 = 2000 minor). Mirrors the wallet column default. */
export const DEFAULT_TOPUP_THRESHOLD_MINOR = 2000;

/** Default auto-top-up reload (AUD 100 = 10000 minor). Mirrors the wallet column default. */
export const DEFAULT_TOPUP_RELOAD_MINOR = 10000;

/**
 * BAL-379 — how long a `credit_wallets.pending_topup_at` marker keeps a wallet's auto-top-up
 * single-in-flight (15 min). While the marker is set AND younger than this TTL, the engine's
 * safe-to-charge guard skips (`topup_in_flight`), so a second session can't fire a concurrent
 * reload before the first PI's success/fail webhook clears the marker. A marker OLDER than the
 * TTL is treated as stale/lost (the success/fail webhook never arrived) and a later crossing may
 * re-fire — self-healing. 15 min is >> normal webhook latency (< 5s), and << Stripe's ~24h
 * idempotency-key-expiry edge, so a re-fire after the TTL still reuses the crossing's stable key
 * when the entry hasn't changed (and mints a fresh key when a new session has moved the ledger).
 */
export const TOPUP_IN_FLIGHT_TTL_MS = 15 * 60 * 1000;

/**
 * Rolling wallet expiry window, in months: expiry = last ledger-affecting interaction
 * + this many months. Feeds `make_interval(months => WALLET_EXPIRY_MONTHS)` in
 * `applyLedgerEntry`.
 */
export const WALLET_EXPIRY_MONTHS = 12;

// ── Session drawdown / overdraft (BAL-378 / ADR-1040 Lane 2) ──────────────
//
// Pure code constants (no platform-config table). Snapshotted onto a
// `credit_sessions` row at `open` so a live session's economics never drift
// mid-call, and read by the metering primitive / drawdown projection / reaper.

/**
 * The overdraft grace window, in minutes: once a wallet drains to zero WITH an active
 * mandate, metering continues on card-backed grace for at most this long before the
 * session is warmly wrapped (Model C). Snapshotted onto `credit_sessions.graceBoundMinutes`.
 */
export const OVERDRAFT_GRACE_MINUTES = 30;

/**
 * Runway threshold (in projected minutes remaining) that fires the one-shot low-balance
 * warning while a session is still funded (`credit_sessions.lowWarnedAt`). Presentational
 * nudge only — it never gates money.
 */
export const LOW_BALANCE_WARNING_MINUTES = 8;

/**
 * Grace-remaining threshold (in minutes) that fires the one-shot near-wrap warning while a
 * session is in grace (`credit_sessions.nearWrapWarnedAt`). Presentational nudge only.
 */
export const NEAR_WRAP_MINUTES = 10;

/**
 * Hard safety cap on a single session's connected duration (AUD-agnostic). A connected
 * session with no explicit `end` and no balance/ceiling stop is force-ended by the reaper
 * once it exceeds this many minutes (bounds an abandoned call). BAL-378 Decision Q3.
 */
export const MAX_SESSION_MINUTES = 240;

/**
 * How long a `wrapped` (warmly-paused) session may sit idle before the reaper auto-`end`s it
 * → single settlement. BAL-378 Decision Q3.
 */
export const WRAPPED_IDLE_END_MINUTES = 15;

/**
 * How long a `pending` (opened-but-never-connected) session may sit before the reaper
 * auto-`cancel`s it and releases its hold. BAL-378 Decision Q3.
 */
export const PENDING_STALE_CANCEL_MINUTES = 30;

/**
 * Upper age bound (minutes since `endedAt`) past which the reaper STOPS auto-re-charging a
 * settlement stuck in `processing`. Stripe expires an idempotency key after ~24h, so a
 * re-charge past that window would mint a SECOND PaymentIntent → double-charge the card
 * (the ledger credit dedups, the card does not). Set to 20h < 24h to leave headroom; past
 * it the reaper raises a Sentry-visible `log.error` for manual handling instead of
 * re-charging. BAL-378 FIX 6.
 */
export const SETTLEMENT_RECONCILE_MAX_AGE_MINUTES = 20 * 60;

/**
 * A per-HOUR minor-unit rate → the per-MINUTE minor-unit drawdown rate:
 * `round(hourlyRateCents / 60)` (half-away-from-zero, integer minor units). Applied to the
 * marked-up client hourly (→ `clientRateMinorPerMinute`) AND the raw expert hourly (→
 * `expertRateMinorPerMinute`) at `open`. Round hourly-then-divide (BAL-378 Decision Q4).
 */
export function deriveMinuteRateCents(hourlyRateCents: number): number {
  return Math.round(hourlyRateCents / 60);
}

/**
 * Rolling-expiry dormancy reminder bands, in days pre-expiry (widest → nearest). The
 * daily dormancy sweep (BAL-380) matches a wallet's absolute `expires_at` against each
 * band's 1-day window; the cron cadence equals the band width so every wallet crosses
 * each band on ~one tick. Order matters only for consistent emit ordering.
 */
export const DORMANCY_REMINDER_WINDOWS_DAYS = [60, 30] as const;

/**
 * Indicative display-FX is hidden by consumer surfaces once the served quote is older
 * than this (48h, in milliseconds). Presentation-only — the real AUD figure never
 * depends on the feed (ADR-1040 invariant #8).
 */
export const FX_DISPLAY_STALENESS_MS = 48 * 60 * 60 * 1000;

/**
 * Pure: is a display-FX quote older than the 48h staleness threshold? The SINGLE
 * decision function — the FX sweep uses it to emit `credit_fx_cache_stale`, and consumer
 * surfaces (later lanes) use it to hide the indicative secondary and render AUD only.
 */
export function isFxRateStale(asOf: Date, now: Date): boolean {
  return now.getTime() - asOf.getTime() > FX_DISPLAY_STALENESS_MS;
}
