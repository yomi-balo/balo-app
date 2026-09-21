import { applyBaloFee, deriveMinuteRateCents, DEFAULT_BALO_FEE_BPS } from '../pricing';

/**
 * BAL-478 (ADR-1040) — THE pre-connect session derivation, extracted VERBATIM from
 * `creditSessionsRepository.open` (`credit-sessions.ts:1058-1064`) so the authoritative in-txn
 * gate and the BAL-478 booking pre-check compute the same figure from the same arithmetic.
 *
 * ⚠⚠ ONE DEFINITION, TWO CONSUMERS. Never inline `estimatedMinutes × deriveMinuteRateCents(
 * applyBaloFee(...))` at a call site again — that duplication is exactly what BAL-478's AC
 * ("do not invent a second estimator") forbids, and it is the arithmetic the money gate runs on.
 *
 * ⚠ ROUND HOURLY, THEN DIVIDE (BAL-378 Decision Q4). `deriveMinuteRateCents(applyBaloFee(h, bps))`
 * is NOT interchangeable with `applyBaloFee(deriveMinuteRateCents(h), bps)` — at h=12345,
 * bps=2500 the two give 257 and 258 minor/minute. Pinned by `session-estimate.test.ts`.
 *
 * ⚠ SERVER-SIDE ONLY IN PRACTICE. `expertRateMinorPerMinute` is the RAW consultant rate and no
 * field here may be serialized to a client bundle or rendered — booking shows no rate anywhere
 * (BAL-400 D4c) and the Balo fee is concealed.
 *
 * `baloFeeBps` is returned RESOLVED (the `?? DEFAULT_BALO_FEE_BPS` lives here, once), because
 * `open()` snapshots it onto the `credit_sessions` row.
 */
export interface SessionEstimate {
  readonly baloFeeBps: number;
  readonly clientRateMinorPerMinute: number;
  readonly expertRateMinorPerMinute: number;
  readonly estimateMinor: number;
}

export function deriveSessionEstimate(input: {
  readonly expertHourlyMinor: number;
  readonly estimatedMinutes: number;
  /** Omitted ⇒ `DEFAULT_BALO_FEE_BPS`, exactly what `open()`'s `input.baloFeeBps ?? …` meant. */
  readonly baloFeeBps?: number;
}): SessionEstimate {
  const baloFeeBps = input.baloFeeBps ?? DEFAULT_BALO_FEE_BPS;
  const clientRateMinorPerMinute = deriveMinuteRateCents(
    applyBaloFee(input.expertHourlyMinor, baloFeeBps)
  );
  return {
    baloFeeBps,
    clientRateMinorPerMinute,
    expertRateMinorPerMinute: deriveMinuteRateCents(input.expertHourlyMinor),
    estimateMinor: input.estimatedMinutes * clientRateMinorPerMinute,
  };
}
