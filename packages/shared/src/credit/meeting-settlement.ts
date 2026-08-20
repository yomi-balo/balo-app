/**
 * BAL-412 (ADR-1044 §7, amending ADR-1040 §8) — THE PURE PRESENCE-SETTLEMENT CORE.
 *
 * ⚠⚠ THE NAMED EXCEPTION LIVES HERE. ADR-1044 §7 amends the "expert always paid actual
 * minutes" invariant to **"expert paid for time made available, with a 15-minute floor when
 * present"** — NOT "always paid actual minutes". This module is where that exception is
 * NAMED rather than quiet, because a later refactor restoring the old phrasing is exactly the
 * hazard the ADR calls out.
 *
 * Dependency-free (NO `@balo/db`, NO I/O, NO clock read, NO `process.env`) — behind the
 * `@balo/shared/credit` subpath so the invariant suite in `packages/db` and the settlement
 * service in `apps/api` both reach ONE definition, and neither drags the postgres driver
 * anywhere. It sits beside `drawdown-state.ts` and `money-block.ts` for the same reason those
 * are there.
 *
 * ⚠ IT IS A NEW FILE RATHER THAN AN ADDITION TO `./settlement.ts` — that file's verified
 * property ("contains no minute arithmetic, only mandate predicates and row narrowing") stays
 * true. The named exception gets its own home, which is what makes it *named*.
 *
 * ── D3's outcome-resolution table, exhaustively ──────────────────────────────────────────
 *
 * | # | expertEverPresent | clientSideEverPresent | effective ≥ floor | shape             | outcome        | money |
 * | - | ------------------ | ---------------------- | ------------------ | ----------------- | -------------- | ----- |
 * | 1 | false               | any                     | —                   | missed_call        | missed_call    | zero, hold released, no accrual |
 * | 2 | true                | false                   | true                | no_show_client     | no_show_client | floor |
 * | 3 | true                | false                   | false               | abandoned_wait     | completed ⚠    | zero, hold released, no accrual |
 * | 4 | true                | true                    | —                   | held               | completed      | ceil(max(effective, floor)) |
 *
 * Row 3 is D2: the expert joined, waited, and left BELOW the 15-minute floor with no client
 * ever present. ADR-1044 §7 makes the FULL 15 minutes the earning condition ("the expert may
 * end the call at that point but must remain present for the full 15 minutes to earn the
 * block") — an expert who leaves at minute 8 has not met it, so this settles at ZERO. It
 * writes `outcome: 'completed'` because BAL-412 mints NO fourth `meeting_outcome` value
 * (`meetingOutcomeEnum` stays `['completed','no_show_client','missed_call']`) — `shape` is
 * what keeps the two zero cases (`missed_call` vs `abandoned_wait`) distinguishable
 * afterwards on `credit_sessions.settlement_shape`, since `meetings.outcome` structurally
 * cannot. This is NOT a bug on read.
 *
 * Row 1 is BAL-134's `missed_call`, already written by the lifecycle sweep
 * (`resolveTerminalRule`). Settlement re-derives the identical label and the repository writes
 * it only if `meetings.outcome` is still NULL — so a human End on a never-joined meeting still
 * resolves an outcome, and the sweep's write is never overwritten.
 *
 * **Row 4 prices `expertPresentMs`, NOT `billableMs` (D1).** `billableMs` is UNTOUCHED by this
 * ticket and remains BAL-134's analytics figure on `meeting_ended` — do not repurpose it and
 * do not "align" the two clocks. Accepted and documented: a client who joins two minutes after
 * the expert pays from the expert's join. That is the literal reading of ADR-1040 §8 /
 * ADR-1044 §7 — "expert paid for time made available" — and it is what stops a no-show
 * needing a separate code branch (a no-show has `billableMs === 0`).
 *
 * **D1a — no GAP cap in v1.** A client who drops mid-call and returns is still billed the
 * continuous span, because the expert held the room throughout — the same principle as D1. No
 * gap-aware input is added here.
 *
 * ⚠⚠ **BUT THE SPAN ITSELF IS CAPPED, AND IT MUST BE — `maxBillableMinutes` IS REQUIRED.** An
 * earlier revision of this docblock claimed *"`effectiveCeilingMinor` remains the money-side
 * backstop this already has"*. **THAT WAS FALSE**, and it is corrected here rather than quietly
 * reworded because it was the stated reason no bound was added. NOTHING in the settlement path
 * reads `effectiveCeilingMinor`: that column bounds the LIVE METER's overdraft wrap
 * (`applyGraceTick`), never this function's `ruleMinutes`, and every other cap is disabled on
 * exactly this provenance (`enforceMaxDuration` skips `presence`; `findWrappedIdle` excludes
 * `presence`; the idle-end rule needs an EMPTY room). Without a cap here, an expert who leaves
 * the tab open for eight hours on a 30-minute call settles at 480 minutes and
 * `finalizeAndSettle` → `settleOverdraft` charges it OFF-SESSION against the stored company
 * mandate, with no human in the loop. `maxBillableMinutes` is that bound; the caller supplies
 * `MAX_SESSION_MINUTES` at the `apps/api` boundary, and {@link MeetingSettlement.uncappedRuleMinutes}
 * exposes when it bound so the caller can `log.error`.
 */

import type { MeetingClocks } from '../meetings';
import { expertClockStart } from '../meetings/lifecycle';

/** How the presence settlement resolved. Four shapes; only THREE `meeting_outcome` labels (D2/D3). */
export type MeetingSettlementShape = 'held' | 'no_show_client' | 'missed_call' | 'abandoned_wait';

/** The three SHIPPED `meeting_outcome` labels (`enums.ts`). No new value is minted (D2). */
export type MeetingSettlementOutcome = 'completed' | 'no_show_client' | 'missed_call';

export interface MeetingSettlementInput {
  /** From `meetingPresenceRepository.settlementFacts` — `computeMeetingClocks` at `ended_at`. */
  readonly clocks: MeetingClocks;
  /** `meetings.scheduled_start` — the D4 clock-start clamp anchor. */
  readonly scheduledStart: Date;
  /**
   * ⚠ NOT DERIVABLE FROM `clocks`. `billableStartedAt === null` also covers a client who
   * joined and left BEFORE the expert arrived (ADR-1049 A2's removed `!clientSideEverPresent`
   * guard). Comes from `summarisePresence(...).clientSideEverPresent`.
   */
  readonly clientSideEverPresent: boolean;
  /** The billing floor in ms. INJECTED (D5) — this module reads no constant and no env. */
  readonly floorMs: number;
  /** `credit_sessions.connected_minutes` — minutes ALREADY drawn against the wallet. */
  readonly minutesAlreadyDrawn: number;
  /**
   * ⚠⚠ THE UPPER BOUND ON THE PRESENCE-DERIVED FIGURE, IN WHOLE MINUTES. **REQUIRED** — see
   * this module's docblock for why a default (or an omission) is a real unbounded-charge path
   * and why `effectiveCeilingMinor` does NOT bound it. INJECTED, exactly like `floorMs`: this
   * module reads no constant and no env. The `apps/api` boundary supplies
   * `MAX_SESSION_MINUTES` (`resolveMaxBillableMinutes()`, beside `resolveBillingFloorMs()`).
   *
   * It caps `ruleMinutes` ONLY. It cannot cap {@link MeetingSettlement.billableMinutes} below
   * `minutesAlreadyDrawn` — the ledger is append-only and a refund is not a primitive that
   * exists (the Q1 no-refund clamp below). Money already drawn past the cap is the meter's
   * problem to prevent, not settlement's to reverse; the caller `log.error`s both.
   */
  readonly maxBillableMinutes: number;
}

export interface MeetingSettlement {
  readonly shape: MeetingSettlementShape;
  readonly outcome: MeetingSettlementOutcome;
  /** `expertPresentMs` after the D4 clamp to `max(scheduled_start, expert first join)`. */
  readonly effectiveExpertPresentMs: number;
  /** `ceil(effectiveExpertPresentMs / 60_000)` — pre-floor. Persisted as `actual_minutes`. */
  readonly actualMinutes: number;
  /** THE SETTLED FIGURE. Client charge AND expert accrual both derive from this ONE number. */
  readonly billableMinutes: number;
  /** `true` when the floor is what fixed `billableMinutes` (i.e. `billableMinutes > actualMinutes`). */
  readonly floorApplied: boolean;
  /** First `session_consume` tick seq the settlement must post (`minutesAlreadyDrawn + 1`). */
  readonly topUpFromTickSeq: number;
  /** Last tick seq to post. `< topUpFromTickSeq` ⇒ post NOTHING (both zero shapes, and a no-op replay). */
  readonly topUpToTickSeq: number;
  /**
   * BAL-412 (Q1) — the PRESENCE-DERIVED figure BEFORE the no-refund clamp, i.e. what
   * `billableMinutes` would be if it were not floored up to `minutesAlreadyDrawn`. Exposed so
   * the caller (`settleSessionFromPresence`) can detect and `log.error` the clamp (the
   * ⚠ KNOWN LIMITATION named on {@link resolveMeetingSettlement}) WITHOUT re-deriving this
   * module's arithmetic a second time. `billableMinutes > ruleMinutes` ⇔ the clamp fired.
   */
  readonly ruleMinutes: number;
  /**
   * BAL-412 (F1) — the presence-derived figure BEFORE {@link MeetingSettlementInput.maxBillableMinutes}
   * capped it. Surfaced for exactly the same reason `ruleMinutes` is: so the caller
   * (`settleSessionFromPresence`) can detect and `log.error` a cap that BOUND without
   * re-deriving this module's arithmetic. `uncappedRuleMinutes > ruleMinutes` ⇔ the cap fired,
   * which means a presence span longer than any legitimate consultation was observed and the
   * charge was held at the cap.
   */
  readonly uncappedRuleMinutes: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * D4 — THE CLOCK-START CLAMP, APPLIED IN THE SETTLEMENT LAYER ONLY. `computeMeetingClocks` is
 * NOT touched (it takes no `scheduledStart` and is pinned by `packages/shared/src/meetings/
 * index.test.ts`, consumed by `end-meeting.ts` analytics and BAL-403's panel). This function
 * re-derives the expert-present clock anchored at `max(scheduled_start, expert first join)` so
 * an early joiner is not credited for arriving early.
 *
 * ```
 * clockStart              = expertClockStart(scheduledStart, clocks.expertFirstJoinedAt)
 * lastExpertPresenceMs     = expertFirstJoinedAt + expertPresentMs
 * effectiveExpertPresentMs = max(0, lastExpertPresenceMs − clockStart)
 * ```
 *
 * `0` when the expert never joined, or on any non-finite instant (fail closed) — matching
 * `computeMeetingClocks`'s own guard and honouring `@balo/shared/meetings`' written
 * assignment to BAL-412: "must not settle on intervals it did not verify."
 *
 * ⚠ The write-side R10 clamp (`presence-writer.ts`, `notBefore: meeting.scheduledStart`)
 * already raises an early `joined_at`, so this `max` is belt-and-braces today. It stays
 * because the settlement layer must not depend on a *writer* to be arithmetically correct,
 * and because an operator-inserted or future non-Drizzle presence row would bypass that
 * clamp.
 */
export function clampedExpertPresentMs(clocks: MeetingClocks, scheduledStart: Date): number {
  const { expertFirstJoinedAt, expertPresentMs } = clocks;
  if (expertFirstJoinedAt === null) {
    return 0;
  }
  const clockStart = expertClockStart(scheduledStart, expertFirstJoinedAt);
  if (clockStart === null) {
    // Unreachable: `expertClockStart` returns null only when `expertFirstJoinedAt` is null,
    // which is already excluded above. Guarded rather than asserted, matching this codebase's
    // `noUncheckedIndexedAccess` discipline applied to a nullable.
    return 0;
  }
  const firstJoinedMs = expertFirstJoinedAt.getTime();
  const clockStartMs = clockStart.getTime();
  const lastExpertPresenceMs = firstJoinedMs + expertPresentMs;
  if (
    !Number.isFinite(firstJoinedMs) ||
    !Number.isFinite(clockStartMs) ||
    !Number.isFinite(lastExpertPresenceMs)
  ) {
    // Fail closed — must not settle on an instant it did not verify.
    return 0;
  }
  return Math.max(0, lastExpertPresenceMs - clockStartMs);
}

/** Which of the four D3 shapes applies, from the structural facts alone. */
function resolveShape(
  expertEverPresent: boolean,
  clientSideEverPresent: boolean,
  effectiveExpertPresentMs: number,
  floorMs: number
): MeetingSettlementShape {
  if (!expertEverPresent) {
    return 'missed_call';
  }
  if (clientSideEverPresent) {
    return 'held';
  }
  return effectiveExpertPresentMs >= floorMs ? 'no_show_client' : 'abandoned_wait';
}

/** D3's shape → `meeting_outcome` mapping. `abandoned_wait` deliberately maps to `completed` (D2). */
function outcomeForShape(shape: MeetingSettlementShape): MeetingSettlementOutcome {
  switch (shape) {
    case 'missed_call':
      return 'missed_call';
    case 'no_show_client':
      return 'no_show_client';
    case 'held':
    case 'abandoned_wait':
      // ⚠ `abandoned_wait` → `completed` IS DELIBERATE (D2/D3), NOT A BUG. No fourth
      // `meeting_outcome` value is minted; `shape` (persisted separately on
      // `credit_sessions.settlement_shape`) is what keeps this distinguishable from a
      // genuinely-held call past settlement.
      return 'completed';
  }
}

/**
 * THE FULL SETTLEMENT RESOLUTION (D2/D3/D4, §2.3's arithmetic).
 *
 * ```
 * uncappedRuleMinutes = (shape === 'missed_call' || shape === 'abandoned_wait')
 *                     ? 0
 *                     : ceil(max(effectiveExpertPresentMs, floorMs) / 60_000)
 * ruleMinutes     = min(uncappedRuleMinutes, maxBillableMinutes)  // ⚠ F1 — the upper bound
 * actualMinutes   = ceil(effectiveExpertPresentMs / 60_000)
 * billableMinutes = max(ruleMinutes, minutesAlreadyDrawn)     // ⚠ never a refund — see below
 * floorApplied    = ruleMinutes > actualMinutes                // false on both zero shapes
 * topUpFromTickSeq = minutesAlreadyDrawn + 1
 * topUpToTickSeq   = billableMinutes                            // `< from` ⇒ nothing posted
 * ```
 *
 * ⚠⚠ **`min(…, maxBillableMinutes)` — THE UPPER BOUND (F1).** Required, never defaulted. See
 * this module's docblock: no other cap in the system bounds a `presence` settlement, and an
 * unbounded `ruleMinutes` is an unbounded off-session charge against a stored mandate. When it
 * binds, `uncappedRuleMinutes > ruleMinutes` and the caller MUST `log.error` — a settlement
 * pinned at the cap means the presence data described a call longer than any real consultation.
 *
 * ⚠⚠ **`max(ruleMinutes, minutesAlreadyDrawn)` — THE NO-REFUND CLAMP, STATED RATHER THAN
 * HIDDEN (Q1).** The ledger is append-only (ADR-1040) and a negative correction is a money
 * primitive nobody has scoped. If a session somehow drew more minutes than presence justifies
 * — **⚠ KNOWN LIMITATION: the expert's connection drops mid-call while the client stays in
 * the room.** Ticks keep drawing (`presence` sessions meter live, same as `live_capture`) and
 * the idle auto-end never fires because the room is not empty from the client's side, so the
 * client is billed for expert-absent minutes at the wall-clock meter's pace, while
 * `expertPresentMs` (this function's basis, per D1) would price it lower. Settlement then
 * fixes the figure at what was already drawn rather than writing a refund. **This is a REAL
 * overcharge path, not merely a data-integrity fault**, and it must be revisited before
 * BAL-466 makes any of this live (a refund primitive, or expert-absence-aware metering). Safe
 * to ship today only because nothing opens a `presence` session (D10). The caller
 * (`settleSessionFromPresence`) MUST `log.error` with the full context on this branch.
 *
 * On the two ZERO shapes (`missed_call` / `abandoned_wait`), any `minutesAlreadyDrawn > 0` is
 * a DIFFERENT, PURE data-integrity fault (the expert never joined, or never crossed the
 * floor — nothing should have connected) — same clamp, same caller `log.error`, distinct
 * message.
 */
export function resolveMeetingSettlement(input: MeetingSettlementInput): MeetingSettlement {
  const {
    clocks,
    scheduledStart,
    clientSideEverPresent,
    floorMs,
    minutesAlreadyDrawn,
    maxBillableMinutes,
  } = input;
  const expertEverPresent = clocks.expertFirstJoinedAt !== null;

  const effectiveExpertPresentMs = clampedExpertPresentMs(clocks, scheduledStart);
  const shape = resolveShape(
    expertEverPresent,
    clientSideEverPresent,
    effectiveExpertPresentMs,
    floorMs
  );
  const outcome = outcomeForShape(shape);

  const isZeroShape = shape === 'missed_call' || shape === 'abandoned_wait';
  const uncappedRuleMinutes = isZeroShape
    ? 0
    : Math.ceil(Math.max(effectiveExpertPresentMs, floorMs) / MS_PER_MINUTE);
  // ⚠ F1 — THE UPPER BOUND. `min`, never a silent default: `maxBillableMinutes` is required
  // input precisely so this line cannot be reached with an unbounded figure.
  const ruleMinutes = Math.min(uncappedRuleMinutes, maxBillableMinutes);
  const actualMinutes = Math.ceil(effectiveExpertPresentMs / MS_PER_MINUTE);
  const drawnFloor = Math.max(0, minutesAlreadyDrawn);
  const billableMinutes = Math.max(ruleMinutes, drawnFloor);
  const floorApplied = ruleMinutes > actualMinutes;
  const topUpFromTickSeq = drawnFloor + 1;
  const topUpToTickSeq = billableMinutes;

  return {
    shape,
    outcome,
    effectiveExpertPresentMs,
    actualMinutes,
    billableMinutes,
    floorApplied,
    topUpFromTickSeq,
    topUpToTickSeq,
    ruleMinutes,
    uncappedRuleMinutes,
  };
}
