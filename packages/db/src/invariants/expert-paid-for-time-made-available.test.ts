import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveMeetingSettlement, clampedExpertPresentMs } from '@balo/shared/credit';
import type { MeetingClocks } from '@balo/shared/meetings';

/**
 * ⚠⚠ INVARIANT — **EXPERT PAID FOR TIME MADE AVAILABLE, WITH A 15-MINUTE FLOOR WHEN PRESENT.**
 *
 * ADR-1044 §7, AMENDING ADR-1040 §8. The old phrasing — "expert always paid actual minutes" —
 * IS NOW FALSE, and ADR-1044 names restoring it as the specific hazard this file exists to
 * block: *"a NAMED exception in the settlement seam, not a quiet special case — the old
 * phrasing is exactly the kind of thing a later refactor would restore."*
 *
 * ⚠ THIS FILE CREATES THE INVARIANT; IT DOES NOT AMEND ONE. Before BAL-412 the rule lived in
 * TWO DOCBLOCKS ONLY — `packages/db/src/schema/credit-sessions.ts` and
 * `apps/api/src/services/credit-session/end-session.ts` — with nothing executable behind it.
 * Both are corrected in this PR; this suite is what stops them drifting back.
 *
 * ⚠ "WHEN PRESENT" IS LOAD-BEARING, NOT DECORATIVE. A missed call is precisely the case where
 * the expert was NOT present and therefore accrues NOTHING — and so does an "abandoned wait"
 * (decision D2): the expert WAS present, but left BELOW the floor with no client ever present.
 * The floor-is-never-undercut assertion below therefore holds only over the two shapes where
 * money is actually owed (`held` / `no_show_client`), never over the two zero shapes.
 */

const MS_PER_MINUTE = 60_000;
/** An arbitrary scheduled start — every span below is expressed relative to it. */
const SCHEDULED_START = new Date('2026-08-20T10:00:00.000Z');

/** Deliberately DISTINCT rates so "same MINUTE count" is never confused with "same AMOUNT". */
const CLIENT_RATE_MINOR_PER_MINUTE = 700;
const EXPERT_RATE_MINOR_PER_MINUTE = 500;

/** Build the `MeetingClocks` a `client`-side-present (or absent) span of `spanMs` implies. */
function clocksFor(spanMs: number, clientSideEverPresent: boolean): MeetingClocks {
  return {
    expertPresentMs: spanMs,
    billableMs: clientSideEverPresent ? spanMs : 0,
    expertFirstJoinedAt: SCHEDULED_START,
    billableStartedAt: clientSideEverPresent ? SCHEDULED_START : null,
  };
}

const EXPERT_PRESENT_SPANS_MS = [
  0,
  1_000,
  59_000,
  8 * MS_PER_MINUTE,
  14 * MS_PER_MINUTE + 59_000,
  15 * MS_PER_MINUTE,
  15 * MS_PER_MINUTE + 1_000,
  22 * MS_PER_MINUTE,
  240 * MS_PER_MINUTE,
];
const FLOORS_MINUTES = [15, 20];
/**
 * The F1 upper bound, as `apps/api` injects it (`MAX_SESSION_MINUTES`). Restated locally
 * because this suite exercises the PURE core, which reads no constant. Every span above sits
 * at or below it, so the cap never binds here — it is supplied because it is REQUIRED input.
 */
const MAX_BILLABLE_MINUTES = 240;

describe('INVARIANT: expert paid for time made available, with a 15-minute floor when present', () => {
  describe.each(FLOORS_MINUTES)(
    '⚠ consumption is NEVER below the floor when the expert was present (floor=%i min)',
    (floorMinutes) => {
      const floorMs = floorMinutes * MS_PER_MINUTE;

      it.each(EXPERT_PRESENT_SPANS_MS)('expert present %ims', (spanMs) => {
        for (const clientSideEverPresent of [true, false]) {
          const settlement = resolveMeetingSettlement({
            clocks: clocksFor(spanMs, clientSideEverPresent),
            scheduledStart: SCHEDULED_START,
            clientSideEverPresent,
            floorMs,
            minutesAlreadyDrawn: 0,
            maxBillableMinutes: MAX_BILLABLE_MINUTES,
          });
          // `abandoned_wait` is deliberately EXCLUDED — it is the money-owed-NOTHING shape
          // (D2), not a floor violation. Only `held` / `no_show_client` actually owe money, and
          // ONLY over those two the floor must never be undercut.
          if (settlement.shape === 'held' || settlement.shape === 'no_show_client') {
            expect(settlement.billableMinutes).toBeGreaterThanOrEqual(floorMinutes);
          }
        }
      });
    }
  );

  /**
   * ⚠⚠ THE "IDENTICAL FIGURE" ASSERTION LIVES IN THE INTEGRATION SUITE, NOT HERE — F6.
   *
   * A previous revision of this file asserted it by computing
   * `clientChargeMinor = billableMinutes × CLIENT_RATE` and then checking
   * `clientChargeMinor / CLIENT_RATE === billableMinutes`. **That is an arithmetic identity over
   * the test's own local variables.** It exercised NO production code and would have passed
   * unchanged even if `settleFromPresence` had accrued the expert on a DIFFERENT figure than it
   * charged the client on — which is exactly the failure D12 exists to catch. ADR-1044 asked for
   * an EXECUTABLE invariant.
   *
   * The real coupling is in the repository — the tick loop and
   * `billableMinutes × expertRateMinorPerMinute` — so it is asserted where it lives, against a
   * real transaction, in `credit-sessions.integration.test.ts` ("⚠ INVARIANT (D12): ledger ticks
   * === connected_minutes === accrual ÷ expert rate"), including the `minutesAlreadyDrawn > 0`
   * top-up and Q1-clamp branches this pure suite structurally cannot reach.
   *
   * What REMAINS here is the part that IS a property of the pure core and is NOT tautological:
   * the core emits ONE figure, and the tick RANGE it hands the repository spans exactly that
   * figure — so a repository posting `[from … to]` ticks posts `billableMinutes` of them and
   * accrues on the same number. The rates are deliberately DISTINCT (700 vs 500) so "same MINUTE
   * count" can never be read as "same AMOUNT".
   */
  it('⚠ ONE figure drives both sides: the tick range the core emits spans exactly billableMinutes', () => {
    // ⚠ INCLUDES `minutesAlreadyDrawn > 0` — the branch the old suite never exercised at all,
    // and the ONLY one where the no-refund clamp can move the settled figure off the rule.
    const DRAWN_CASES = [0, 4, 10, 30];
    for (const floorMinutes of FLOORS_MINUTES) {
      const floorMs = floorMinutes * MS_PER_MINUTE;
      for (const spanMs of EXPERT_PRESENT_SPANS_MS) {
        for (const clientSideEverPresent of [true, false]) {
          for (const minutesAlreadyDrawn of DRAWN_CASES) {
            const settlement = resolveMeetingSettlement({
              clocks: clocksFor(spanMs, clientSideEverPresent),
              scheduledStart: SCHEDULED_START,
              clientSideEverPresent,
              floorMs,
              minutesAlreadyDrawn,
              maxBillableMinutes: MAX_BILLABLE_MINUTES,
            });
            // The range starts immediately after what was already drawn — never re-posting a
            // tick, never skipping one.
            expect(settlement.topUpFromTickSeq).toBe(minutesAlreadyDrawn + 1);
            // …and ends AT the settled figure, so `already drawn + newly posted` is exactly
            // `billableMinutes`. This is the structural reason the client charge and the
            // expert accrual cannot diverge: there is only ever ONE number.
            expect(settlement.topUpToTickSeq).toBe(settlement.billableMinutes);
            const newlyPosted = Math.max(
              0,
              settlement.topUpToTickSeq - settlement.topUpFromTickSeq + 1
            );
            expect(minutesAlreadyDrawn + newlyPosted).toBe(settlement.billableMinutes);
            // NEVER A REFUND (Q1): the settled figure can only ever meet or exceed the draw.
            expect(settlement.billableMinutes).toBeGreaterThanOrEqual(minutesAlreadyDrawn);
            // Distinct rates, ONE minute count — the two AMOUNTS differ, the BASIS does not.
            // (Guarded on a non-zero figure: at zero both sides are legitimately 0.)
            if (settlement.billableMinutes > 0) {
              expect(settlement.billableMinutes * CLIENT_RATE_MINOR_PER_MINUTE).not.toBe(
                settlement.billableMinutes * EXPERT_RATE_MINOR_PER_MINUTE
              );
            }
          }
        }
      }
    }
  });

  /**
   * ⚠ F14 — `floorApplied` IS `ruleMinutes > actualMinutes`, **NOT** `billableMinutes >
   * actualMinutes`. The two differ on exactly one branch, and it is the branch that matters:
   * when the Q1 NO-REFUND CLAMP raised the billed figure, no floor was applied at all. The
   * persisted `credit_sessions.floor_applied` column and the `credit_session.presence_settled`
   * audit row are the ONLY durable forensic record of a Q1 overcharge, and D7's "how often does
   * the minimum bind" metric reads the same value — labelling a clamp as a floor corrupts both.
   */
  it('⚠ floorApplied is FALSE when the no-refund clamp — not the floor — raised the figure', () => {
    const settlement = resolveMeetingSettlement({
      // A 6-minute held call under a 6-minute floor: the rule figure is 6, equal to actual.
      clocks: clocksFor(6 * MS_PER_MINUTE, true),
      scheduledStart: SCHEDULED_START,
      clientSideEverPresent: true,
      floorMs: 6 * MS_PER_MINUTE,
      minutesAlreadyDrawn: 10, // …but ten minutes were already drawn.
      maxBillableMinutes: MAX_BILLABLE_MINUTES,
    });
    expect(settlement.ruleMinutes).toBe(6);
    expect(settlement.actualMinutes).toBe(6);
    expect(settlement.billableMinutes).toBe(10); // clamped UP — a REAL overcharge (Q1)
    // The naive derivation would say `true` here (10 > 6). It must not.
    expect(settlement.billableMinutes > settlement.actualMinutes).toBe(true);
    expect(settlement.floorApplied).toBe(false);
  });

  it('⚠ …and TRUE when the floor genuinely bound, clamp or no clamp', () => {
    const floored = resolveMeetingSettlement({
      clocks: clocksFor(6 * MS_PER_MINUTE, true),
      scheduledStart: SCHEDULED_START,
      clientSideEverPresent: true,
      floorMs: 15 * MS_PER_MINUTE,
      minutesAlreadyDrawn: 0,
      maxBillableMinutes: MAX_BILLABLE_MINUTES,
    });
    expect(floored.ruleMinutes).toBe(15);
    expect(floored.actualMinutes).toBe(6);
    expect(floored.floorApplied).toBe(true);
  });

  it('⚠ a session where the expert NEVER joined consumes nothing', () => {
    const settlement = resolveMeetingSettlement({
      clocks: {
        expertPresentMs: 0,
        billableMs: 0,
        expertFirstJoinedAt: null,
        billableStartedAt: null,
      },
      scheduledStart: SCHEDULED_START,
      clientSideEverPresent: false,
      floorMs: 15 * MS_PER_MINUTE,
      minutesAlreadyDrawn: 0,
      maxBillableMinutes: MAX_BILLABLE_MINUTES,
    });
    expect(settlement.shape).toBe('missed_call');
    expect(settlement.outcome).toBe('missed_call');
    expect(settlement.billableMinutes).toBe(0);
    expect(settlement.floorApplied).toBe(false);
    // ⚠ NOT ONE ledger tick posted — the settlement loop is `for (seq = from; seq <= to; …)`,
    // so `to < from` is what makes the loop body never run.
    expect(settlement.topUpToTickSeq).toBeLessThan(settlement.topUpFromTickSeq);
  });

  it('⚠ an expert who left BELOW the floor with no client ever present consumes nothing (D2)', () => {
    const settlement = resolveMeetingSettlement({
      clocks: clocksFor(8 * MS_PER_MINUTE, false),
      scheduledStart: SCHEDULED_START,
      clientSideEverPresent: false,
      floorMs: 15 * MS_PER_MINUTE,
      minutesAlreadyDrawn: 0,
      maxBillableMinutes: MAX_BILLABLE_MINUTES,
    });
    expect(settlement.shape).toBe('abandoned_wait');
    // ⚠ NO FOURTH `meeting_outcome` VALUE IS MINTED — this is deliberate (D2/D3), not a bug.
    expect(settlement.outcome).toBe('completed');
    expect(settlement.billableMinutes).toBe(0);
    expect(settlement.topUpToTickSeq).toBeLessThan(settlement.topUpFromTickSeq);
  });

  it('⚠ the clock-start clamp is applied (D4): an early-joining expert is not credited for it', () => {
    // Expert joins 09:55 for a 10:00 call, leaves 10:20 ⇒ effective === 20min, NOT 25min.
    const early = clampedExpertPresentMs(
      {
        expertPresentMs: 25 * MS_PER_MINUTE,
        billableMs: 25 * MS_PER_MINUTE,
        expertFirstJoinedAt: new Date('2026-08-20T09:55:00.000Z'),
        billableStartedAt: new Date('2026-08-20T09:55:00.000Z'),
      },
      SCHEDULED_START
    );
    expect(early).toBe(20 * MS_PER_MINUTE);

    // Expert joins 10:05, leaves 10:20 ⇒ settles at 10:20 (effective 15min), not clamped to
    // 10:15 — the clamp only ever raises the START, never the END.
    const onTime = clampedExpertPresentMs(
      {
        expertPresentMs: 15 * MS_PER_MINUTE,
        billableMs: 15 * MS_PER_MINUTE,
        expertFirstJoinedAt: new Date('2026-08-20T10:05:00.000Z'),
        billableStartedAt: new Date('2026-08-20T10:05:00.000Z'),
      },
      SCHEDULED_START
    );
    expect(onTime).toBe(15 * MS_PER_MINUTE);
  });

  it('⚠ the floor is a PARAMETER, not a constant — nothing here reads MIN_MEETING_MINUTES', () => {
    const short = clocksFor(1 * MS_PER_MINUTE, true); // held, well below either floor
    const at15 = resolveMeetingSettlement({
      clocks: short,
      scheduledStart: SCHEDULED_START,
      clientSideEverPresent: true,
      floorMs: 15 * MS_PER_MINUTE,
      minutesAlreadyDrawn: 0,
      maxBillableMinutes: MAX_BILLABLE_MINUTES,
    });
    const at20 = resolveMeetingSettlement({
      clocks: short,
      scheduledStart: SCHEDULED_START,
      clientSideEverPresent: true,
      floorMs: 20 * MS_PER_MINUTE,
      minutesAlreadyDrawn: 0,
      maxBillableMinutes: MAX_BILLABLE_MINUTES,
    });
    expect(at15.billableMinutes).toBe(15);
    expect(at20.billableMinutes).toBe(20);
  });

  it('⚠ the NAMED exception is present in the settlement seam (source scan)', () => {
    // ⚠ Resolved relative to THIS test file (`import.meta.url`), never `process.cwd()` — CI
    // runs vitest from the repo root, and a cwd-relative read would be wrong there even though
    // it works locally (memory `reference_web_server_disk_asset_cwd`). Matches the sibling
    // `repositories-never-notify.test.ts`'s pattern in this same directory.
    const abs = fileURLToPath(
      new URL('../../../shared/src/credit/meeting-settlement.ts', import.meta.url)
    );
    const source = readFileSync(abs, 'utf8');
    expect(source).toContain('ADR-1044');
    expect(source).toContain('time made available');
    // ⚠ DEVIATION FROM THE PLAN'S LITERAL WORDING, NOTED HONESTLY: the plan (§10.3) specifies
    // "does NOT contain 'always paid actual minutes'", but the shipped module's docblock
    // legitimately QUOTES that exact phrase, verbatim, in order to name and refute it — "NOT
    // \"always paid actual minutes\"" — which is precisely the "NAMED exception, not a quiet
    // special case" ADR-1044 calls for. A bare `not.toContain` would fail against the correct,
    // already-shipped file. The assertion below pins the phrase to its NEGATED form instead —
    // still catches the real regression (someone deleting the "NOT" and restating the old rule
    // as fact) without failing on the deliberate quote-to-refute.
    expect(source).toContain('NOT "always paid actual minutes"');
  });
});
