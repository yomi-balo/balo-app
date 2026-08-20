/**
 * BAL-412 (ADR-1044 §7, D6) — THE ONE `minutesOfRunway` IMPLEMENTATION.
 *
 * ⚠⚠ D6 — TWO COPIES OF THIS FORMULA EXISTED AND BOTH WERE WRONG THE SAME WAY:
 * `packages/shared/src/credit/drawdown-state.ts` (module-private) and
 * `apps/api/src/services/credit-session/settlement.ts` (exported as `runwayMinutes`, used at
 * `notify.ts`). Both computed `floor(balanceMinor / rate)` with no awareness of the 15-minute
 * billing floor (ADR-1044 §7), so EARLY in a session — before the floor's own minutes are
 * "spent" — the reported runway OVERSTATED how much discretionary time was actually left: the
 * balance still has to cover the UNCONSUMED remainder of the floor before anything beyond it
 * is truly discretionary. Both copies are DELETED; this is the ONE implementation, imported by
 * both sides. Correcting one and not the other would have reintroduced the defect wherever the
 * uncorrected copy remained reachable.
 *
 * Dependency-free (NO `@balo/db`, NO I/O) — behind the `@balo/shared/credit` subpath, same
 * posture as `drawdown-state.ts` and `meeting-settlement.ts`, so it is reachable from the
 * in-session components' type graph without dragging the postgres driver into a client bundle.
 */

export interface RunwayInputs {
  readonly balanceMinor: number;
  readonly ratePerMinuteMinor: number;
  /** ADR-1044 §7's floor, in whole minutes. INJECTED (D5) — this module reads no constant. */
  readonly floorMinutes: number;
  /**
   * Minutes ALREADY DRAWN against the balance (`credit_sessions.connected_minutes`).
   * ⚠ DRAWN, NOT ELAPSED. The balance has already been reduced by exactly `drawn × rate`, so
   * the residual floor liability is `(floor − drawn) × rate`. Wall-clock elapsed lags the
   * ticks by up to a minute and would make the figure disagree with the balance it is derived
   * from.
   */
  readonly minutesAlreadyDrawn: number;
}

/**
 * Whole minutes of DISCRETIONARY runway — balance left after the unconsumed remainder of the
 * 15-minute floor is set aside (ADR-1044 §7). `0` when the rate is unknown/zero or the balance
 * cannot even cover the floor's remainder.
 *
 * **Floor already fully consumed (`minutesAlreadyDrawn >= floorMinutes`):**
 * `unconsumedFloorMinutes = 0`, `committedMinor = 0`, and this reduces **exactly** to the
 * shipped `floor(balance / rate)` — bit-for-bit, no behaviour change. Every session past
 * minute 15 behaves as it does today; pinned by a test.
 *
 * **Floor partially consumed (`minutesAlreadyDrawn < floorMinutes`):** the unconsumed
 * remainder's cost is set aside first. Worked example — `rate = 100`, `floor = 15`,
 * `drawn = 2`, `balance = 3000`: `unconsumed = 13`, `committed = 1300`,
 * `discretionary = 1700` → **17** (the uncorrected formula: 30). The warning fires sooner,
 * which is the intended effect.
 *
 * ⚠ **THE SEMANTIC NUANCE, STATED RATHER THAN GLOSSED (Q2).** Arithmetically, the *maximum
 * additional minutes you can stay* is still `floor(balance/rate)` — once you pass minute 15
 * the floor is absorbed and each further minute costs one rate. What THIS figure reports is
 * **discretionary time beyond the committed floor**, which is the CONSERVATIVE reading and the
 * one the ticket's AC asks for ("`minutesOfRunway` accounts for the unconsumed portion of the
 * floor"; "the warning and nudge are not late"). It never OVERSTATES. The client-facing copy
 * *"About {n} minutes of balance left"* stays truthful under it. Do not "simplify" this back
 * to the uncorrected formula — that is precisely the regression D6 exists to prevent.
 */
export function minutesOfRunway(inputs: RunwayInputs): number {
  const { balanceMinor, ratePerMinuteMinor, floorMinutes, minutesAlreadyDrawn } = inputs;
  if (ratePerMinuteMinor <= 0 || balanceMinor <= 0) {
    return 0;
  }
  const unconsumedFloorMinutes = Math.max(0, floorMinutes - Math.max(0, minutesAlreadyDrawn));
  const committedMinor = unconsumedFloorMinutes * ratePerMinuteMinor;
  const discretionaryMinor = balanceMinor - committedMinor;
  if (discretionaryMinor <= 0) {
    return 0;
  }
  return Math.floor(discretionaryMinor / ratePerMinuteMinor);
}
