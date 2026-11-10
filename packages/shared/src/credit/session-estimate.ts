import { applyBaloFee, DEFAULT_BALO_FEE_BPS } from '../pricing';

/**
 * BAL-478 (ADR-1040) — THE pre-connect session derivation, shared by `creditSessionsRepository.open`
 * and the BAL-478 booking pre-check so the authoritative in-txn gate and the advisory booking
 * gate compute the same figure from the same arithmetic.
 *
 * ⚠⚠ ONE DEFINITION, TWO CONSUMERS. Never inline `estimatedMinutes × applyBaloFee(...)` at a
 * call site — that duplication is exactly what BAL-478's AC ("do not invent a second estimator")
 * forbids, and it is the arithmetic the money gate runs on.
 *
 * ⚠⚠ THE INPUT IS CENTS PER MINUTE. `expert_profiles.rate_cents` is the expert's raw per-minute
 * rate (the settings Rate tab writes `ratePerMinuteCents`; seeds, search and the public profile
 * all read it per minute). The client rate is that figure marked up ONCE by the fee —
 * `applyBaloFee(rate, bps)` — which is exactly the number `publicDisplayRatePerMinute` quotes on
 * the public profile and search cards at the default fee, so a client is billed the rate they
 * were shown. Treating the column as per-hour bills ~1/60th of it.
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
  /** `expert_profiles.rate_cents` — the raw consultant rate, integer cents PER MINUTE. */
  readonly expertRateMinorPerMinute: number;
  readonly estimatedMinutes: number;
  /** Omitted ⇒ `DEFAULT_BALO_FEE_BPS`, exactly what `open()`'s `input.baloFeeBps ?? …` meant. */
  readonly baloFeeBps?: number;
}): SessionEstimate {
  const baloFeeBps = input.baloFeeBps ?? DEFAULT_BALO_FEE_BPS;
  const clientRateMinorPerMinute = applyBaloFee(input.expertRateMinorPerMinute, baloFeeBps);
  return {
    baloFeeBps,
    clientRateMinorPerMinute,
    expertRateMinorPerMinute: input.expertRateMinorPerMinute,
    estimateMinor: input.estimatedMinutes * clientRateMinorPerMinute,
  };
}
