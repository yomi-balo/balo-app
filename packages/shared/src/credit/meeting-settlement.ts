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
 * | 2 | true                | false                   | true                | no_show_client     | no_show_client | floor (FLAT) |
 * | 3 | true                | false                   | false               | abandoned_wait     | completed ⚠    | zero, hold released, no accrual |
 * | 4 | true                | true                    | —                   | held               | completed      | ceil(max(together + effective, floor)) |
 *
 * ⚠⚠ ROW 2 IS **FLAT**, NOT A MINIMUM (owner ruling, 2026-08-21) — see
 * {@link resolveMeetingSettlement}. An expert who waits 40 minutes on a client no-show bills the
 * client the FLOOR (15), not 40, and accrues the same 15. Do not "align" it with row 4.
 *
 * Row 3 is D2: the expert joined, waited, and left BELOW the 15-minute floor with no client
 * ever present. ADR-1044 §7 makes the FULL 15 minutes the earning condition ("the expert may
 * end the call at that point but must remain present for the full 15 minutes to earn the
 * block") — an expert who leaves at minute 8 has not met it, so this settles at ZERO. It
 * writes `outcome: 'completed'` because BAL-412 mints NO NEW `meeting_outcome` value of its
 * own here — `meetingOutcomeEnum` now carries a FOURTH label, `venue_unavailable` (BAL-581),
 * but that one is a SYSTEM-TERMINAL-ONLY value this module never writes: a meeting without a
 * venue never opens a credit session, so it never reaches settlement (see
 * {@link MeetingSettlementOutcome} below). `shape` is what keeps the two zero cases
 * (`missed_call` vs `abandoned_wait`) distinguishable afterwards on
 * `credit_sessions.settlement_shape`, since `meetings.outcome` structurally cannot. This is NOT
 * a bug on read.
 *
 * Row 1 is BAL-134's `missed_call`, already written by the lifecycle sweep
 * (`resolveTerminalRule`). Settlement re-derives the identical label and the repository writes
 * it only if `meetings.outcome` is still NULL — so a human End on a never-joined meeting still
 * resolves an outcome, and the sweep's write is never overwritten.
 *
 * **Row 4 prices the expert's presence FROM THE START, plus the time TOGETHER before it (D1, D13, D15.3).**
 * `billableMs` is UNTOUCHED and remains BAL-134's analytics figure on `meeting_ended` — do not
 * repurpose it and do not "align" the two clocks. From the scheduled start the basis is the
 * expert's own span, so a client who joins two minutes after the expert pays from the expert's
 * join (ADR-1040 §8 / ADR-1044 §7 — "expert paid for time made available"), which also stops a
 * no-show needing a separate code branch.
 *
 * ⚠⚠ BAL-474 RULE A (owner ruling D13, 2026-09-27) ADDS ONE TERM, AND ONLY ONE. Before the scheduled
 * start T, the minutes the delivering expert and a client-side participant were ACTUALLY TOGETHER
 * (the sum of the real intersection of their presence before T — {@link MeetingSettlementInput.togetherBeforeStartMs})
 * are billable, on the `held` shape only. From T onward time counts as above, except that the from-start
 * span begins at the expert's first presence AT OR AFTER T (D15.3): a row that spans T starts at T, and a
 * row entirely before T does not anchor it — together 09:00–09:30 and both back at 10:10 bills 30 + 50,
 * not 30 + 60. There is no lower time bound: a solo early wait, or a click days early with nobody else
 * there, bills nothing. The floor and the F1 cap apply to the TOTAL.
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

/**
 * How the presence settlement resolved. Four shapes; only THREE of the (now four) shipped
 * `meeting_outcome` labels (D2/D3). BAL-581's fourth label, `venue_unavailable`, is written
 * only by the lifecycle sweep's rule 5 — a meeting without a venue never opens a credit
 * session, so it never reaches this module.
 */
export type MeetingSettlementShape = 'held' | 'no_show_client' | 'missed_call' | 'abandoned_wait';

/**
 * The THREE of the four SHIPPED `meeting_outcome` labels (`enums.ts`) this module can write.
 * Settlement mints none of these new; `venue_unavailable` is structurally unreachable here
 * (see this file's header and {@link MeetingSettlementShape}).
 */
export type MeetingSettlementOutcome = 'completed' | 'no_show_client' | 'missed_call';

export interface MeetingSettlementInput {
  /**
   * From `meetingPresenceRepository.settlementFacts` — `computeMeetingClocks` at `ended_at`, over
   * intervals CLAMPED to the scheduled start (BAL-134's R10 rule, applied at read time — presence rows
   * are stored at their true instants). It decides the SHAPE (was the expert ever present; the no-show
   * floor test) and the no-show clock, which keep BAL-134's clamped semantics. It is NOT the `held`
   * from-start figure: see {@link MeetingSettlementInput.expertPresentFromStartMs}.
   */
  readonly clocks: MeetingClocks;
  /**
   * ⚠⚠ D15.3 — REQUIRED. The `held` from-start figure: the gap-inclusive span of the expert's presence AT OR
   * AFTER `scheduledStart` (`expertPresentFromStartMs` over the RAW intervals). It is not derivable from
   * {@link MeetingSettlementInput.clocks}: the clamp collapses an expert row that ended before the start into
   * a zero-length row AT the start, which would anchor this figure there even for an expert who came back
   * late. Used on the `held` shape only; every other shape keeps the clamped clock's figure. A non-finite or
   * negative value is `0` (fail closed).
   */
  readonly expertPresentFromStartMs: number;
  /**
   * ⚠⚠ RULE A (D13) — REQUIRED. The milliseconds the delivering expert and a client-side participant
   * were really TOGETHER strictly before `scheduledStart`: `coPresentMsBefore` over the RAW intervals.
   * It is added to the from-T figure on the `held` shape only, and is ignored (treated as `0`) on every
   * other shape. A non-finite or negative value is `0` (fail closed). Required so a caller that forgets
   * it fails to compile rather than silently under-billing.
   */
  readonly togetherBeforeStartMs: number;
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
  /**
   * The from-start figure this settlement used: on `held`, the expert's span from their first presence at or
   * after the start (D15.3); on every other shape, `expertPresentMs` after the D4 clamp to
   * `max(scheduled_start, expert first join)`.
   */
  readonly effectiveExpertPresentMs: number;
  /**
   * RULE A — the time together before the scheduled start that this settlement actually used: the
   * input's value on `held`, `0` on every other shape. `effectiveExpertPresentMs + togetherBeforeStartMs`
   * is the billing basis ({@link billingBasisMs}).
   */
  readonly togetherBeforeStartMs: number;
  /** `ceil((together + effectiveExpertPresentMs) / 60_000)` — pre-floor. Persisted as `actual_minutes`. */
  readonly actualMinutes: number;
  /** THE SETTLED FIGURE. Client charge AND expert accrual both derive from this ONE number. */
  readonly billableMinutes: number;
  /**
   * `true` when the MINIMUM is what fixed the billed figure — i.e. `ruleMinutes > actualMinutes`
   * (the floor RAISED a short `held` call), OR the shape is `no_show_client`, where the floor is
   * flatly the whole charge regardless of how long the expert waited (owner ruling, 2026-08-21).
   *
   * ⚠ It is derived from `ruleMinutes`, NOT `billableMinutes` — `billableMinutes` is post-Q1
   * no-refund clamp, and labelling that clamp a "floor application" is exactly the mislabelling
   * F14 rejected. Both zero shapes are `false`.
   */
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
 * D4 — THE CLOCK-START CLAMP, APPLIED IN THE SETTLEMENT LAYER ONLY. ⚠⚠ D15.3: THIS IS NO LONGER THE `held`
 * FROM-START FIGURE. It is the SHAPE clock: it decides whether an expert with no client waited the floor
 * (`no_show_client` vs `abandoned_wait`) and it is the figure the two zero/flat shapes report. The `held`
 * figure is {@link MeetingSettlementInput.expertPresentFromStartMs}, which counts from the expert's first
 * presence AT OR AFTER the start. The two differ only for an expert with a row that ended before the start
 * and another after it: the clamp collapses the early row to a zero-length row AT the start and so anchors
 * this clock there — the quirk the no-show clock keeps until its own follow-up (owner ruling D15.3).
 *
 * `computeMeetingClocks` is
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
 * ⚠ The READERS apply `clampIntervalsToStart` (BAL-134's R10 rule, moved off the write side by
 * BAL-474 Rule A so the true instants survive for the pre-start intersection), so an early
 * `joined_at` has already been raised to the start and this `max` is belt-and-braces. It stays
 * because the settlement layer must not depend on a *reader* to be arithmetically correct, and
 * because an operator-inserted or future non-Drizzle presence row would bypass that clamp.
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

/** A non-finite or negative figure is `0` — fail closed, never a negative or NaN charge. */
function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * RULE A (D13) — THE ONE DEFINITION OF THE BILLING BASIS, in milliseconds: the time together before the
 * scheduled start plus the from-start figure (`expertPresentFromStartMs`, D15.3). Shared by
 * {@link resolveMeetingSettlement} and the state route's "billable so far" chip, so the figure a client
 * watches and the figure it is billed are one computation. PRE-FLOOR, PRE-CAP.
 */
export function billingBasisMs(input: {
  readonly expertPresentFromStartMs: number;
  readonly togetherBeforeStartMs: number;
}): number {
  return (
    finiteNonNegative(input.togetherBeforeStartMs) +
    finiteNonNegative(input.expertPresentFromStartMs)
  );
}

/**
 * Which of the four D3 shapes applies, from the structural facts alone.
 *
 * ⚠⚠ `no_show_client` IS REACHABLE (ADR-1040 Amendment 7 §D, BAL-474). BAL-466 opens a credit
 * session at the first CLIENT-side member's admission to a `case` meeting, so a client who never
 * joins opens none — and BAL-474 closes that gap on the TERMINAL side: every terminal path (the
 * lifecycle sweep's five rules, a human End, the durability backstop) runs
 * `settleSessionlessCaseMeeting`, which computes THIS shape for a Case meeting that has no session
 * and, when it is `no_show_client` or `held`, opens one on behalf of the booker and settles it in
 * one transaction. The expert who waited the floor is paid it, flat. The two zero shapes
 * (`missed_call`, `abandoned_wait`) still owe nothing and open nothing.
 */
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

/**
 * D3's money column, per shape, BEFORE the F1 cap and the Q1 no-refund clamp.
 *
 * ⚠⚠ `no_show_client` RETURNS THE FLOOR FLAT — it is NOT `max(effective, floor)` (owner ruling,
 * 2026-08-21; see {@link resolveMeetingSettlement}). Because `resolveShape` only reaches this
 * shape when `effective >= floorMs`, a shared `max(...)` would resolve to `effective` every single
 * time and bill the expert's whole wait to a client who never arrived. `held` keeps the `max` —
 * that one IS "time made available, floored".
 */
function uncappedRuleMinutesForShape(
  shape: MeetingSettlementShape,
  basisMs: number,
  floorMs: number
): number {
  switch (shape) {
    case 'missed_call':
    case 'abandoned_wait':
      return 0;
    case 'no_show_client':
      return Math.ceil(floorMs / MS_PER_MINUTE);
    case 'held':
      return Math.ceil(Math.max(basisMs, floorMs) / MS_PER_MINUTE);
  }
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
      // ⚠ `abandoned_wait` → `completed` IS DELIBERATE (D2/D3), NOT A BUG. Settlement mints
      // no outcome of its own for `abandoned_wait`; `shape` (persisted separately on
      // `credit_sessions.settlement_shape`) is what keeps this distinguishable from a
      // genuinely-held call past settlement.
      return 'completed';
  }
}

/**
 * THE FULL SETTLEMENT RESOLUTION (D2/D3/D4, §2.3's arithmetic).
 *
 * ```
 * basisMs             = held → togetherBeforeStartMs + expertPresentFromStartMs   // ⚠ RULE A (D13), D15.3
 *                        otherwise → effectiveExpertPresentMs (the clamped clock, D4)
 * uncappedRuleMinutes = missed_call | abandoned_wait → 0
 *                       no_show_client               → ceil(floorMs / 60_000)          // ⚠ FLAT
 *                       held                         → ceil(max(basisMs, floorMs) / 60_000)
 * ruleMinutes     = min(uncappedRuleMinutes, maxBillableMinutes)  // ⚠ F1 — caps the TOTAL
 * actualMinutes   = ceil(basisMs / 60_000)
 * billableMinutes = max(ruleMinutes, minutesAlreadyDrawn)     // ⚠ never a refund — see below
 * floorApplied    = no_show_client || ruleMinutes > actualMinutes   // false on both zero shapes
 * topUpFromTickSeq = minutesAlreadyDrawn + 1
 * topUpToTickSeq   = billableMinutes                            // `< from` ⇒ nothing posted
 * ```
 *
 * ⚠⚠ **A CLIENT NO-SHOW IS A FIXED FLOOR CHARGE, NOT "TIME MADE AVAILABLE" (owner ruling,
 * 2026-08-21).** The ruling, verbatim: *"For client no-show, the client should only be billed
 * 15min minimum charge. The expert has to stay for this long for the client to be billed that,
 * else, no charge."* So on `no_show_client` the floor IS the whole charge and **the expert's
 * excess wait is deliberately NOT billed to the client** — an expert who leaves the tab open for
 * 40 minutes after a no-show bills 15, and (the AC: one figure drives both sides) accrues 15
 * themselves. The "else, no charge" half is `abandoned_wait`, which stays ZERO.
 *
 * This shape CANNOT be expressed by the shared `ceil(max(effective, floorMs))`: `no_show_client`'s
 * own precondition (`resolveShape`) already REQUIRES `effective >= floorMs`, so that `max` always
 * resolves to `effective` on this shape and the flat rule would silently never apply. Row 4
 * (`held`) is untouched — a real two-party 40-minute call still bills 40.
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
 * overcharge path, not merely a data-integrity fault.** ⚠ BAL-466 makes `presence` sessions
 * live (`joinMeetingAsMember` opens one at admission to a `case` meeting) WITHOUT building the
 * refund primitive or expert-absence-aware metering this paragraph calls for — that remains a
 * known, accepted, un-mitigated residual risk, not a silent gap. The caller
 * (`settleSessionFromPresence`) MUST `log.error` with the full context on this branch, which is
 * how it is surfaced in Axiom until a refund primitive lands.
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

  const clampedPresentMs = clampedExpertPresentMs(clocks, scheduledStart);
  // ⚠ The SHAPE is decided from the CLAMPED clock alone (D4, unchanged; D15.3 leaves the no-show clock
  // alone): neither the together term nor the from-start figure below turns an abandoned wait into a held
  // call or moves a no-show across the floor.
  const shape = resolveShape(expertEverPresent, clientSideEverPresent, clampedPresentMs, floorMs);
  const outcome = outcomeForShape(shape);

  const isZeroShape = shape === 'missed_call' || shape === 'abandoned_wait';
  // RULE A — the pre-start time together counts on `held` only. No-show and abandoned have no client
  // side, and a missed call has no expert, so it is 0 there by construction; the gate states the shape
  // table rather than relying on that.
  const togetherBeforeStartMs =
    shape === 'held' ? finiteNonNegative(input.togetherBeforeStartMs) : 0;
  // D15.3 — on `held` the from-start figure counts from the expert's first presence at or after the start;
  // every other shape keeps the clamped clock's figure (there is no together term to combine it with).
  const effectiveExpertPresentMs =
    shape === 'held' ? finiteNonNegative(input.expertPresentFromStartMs) : clampedPresentMs;
  const basisMs = billingBasisMs({
    expertPresentFromStartMs: effectiveExpertPresentMs,
    togetherBeforeStartMs,
  });
  const uncappedRuleMinutes = uncappedRuleMinutesForShape(shape, basisMs, floorMs);
  // ⚠ F1 — THE UPPER BOUND. `min`, never a silent default: `maxBillableMinutes` is required
  // input precisely so this line cannot be reached with an unbounded figure.
  const ruleMinutes = Math.min(uncappedRuleMinutes, maxBillableMinutes);
  const actualMinutes = Math.ceil(basisMs / MS_PER_MINUTE);
  const drawnFloor = Math.max(0, minutesAlreadyDrawn);
  const billableMinutes = Math.max(ruleMinutes, drawnFloor);
  // ⚠ "the minimum is what FIXED the billed figure" — NOT "the billed figure exceeds actual".
  // On `no_show_client` the floor is flatly the whole charge, so rule (15) is routinely BELOW
  // actual (a 40-minute wait); the old `ruleMinutes > actualMinutes` alone would report `false`
  // on the very shape where the floor is the entire reason for the number.
  const floorApplied = !isZeroShape && (shape === 'no_show_client' || ruleMinutes > actualMinutes);
  const topUpFromTickSeq = drawnFloor + 1;
  const topUpToTickSeq = billableMinutes;

  return {
    shape,
    outcome,
    effectiveExpertPresentMs,
    togetherBeforeStartMs,
    actualMinutes,
    billableMinutes,
    floorApplied,
    topUpFromTickSeq,
    topUpToTickSeq,
    ruleMinutes,
    uncappedRuleMinutes,
  };
}
