import type { MeetingClockState } from '@/components/balo/meetings/meeting-clock-slot';
import type { MeetingStateSnapshot } from './meeting-state';

/**
 * BAL-134 (§7.3) — **THE TOP-BAR CLOCK CHIP'S PRODUCER, AS ONE PURE FUNCTION.**
 *
 * ── ⚠⚠ THE BUG THIS FIXES ────────────────────────────────────────────────────────────────
 *
 * `waiting-state-patch.jsx` records it precisely: `TopBar` computes `live` from
 * `['oneOnOne','gallery','screenshare'].includes(stage)`, so during `waiting` it renders
 * **"Not started"** — while the expert's clock is genuinely running. The shipped analogue is
 * the same defect wearing a different label: `meeting-frame-impl.tsx` produced
 * `hasJoined ? { kind: 'live' } : { kind: 'not_started' }`, and `hasJoined` is TRUE throughout
 * the waiting stage, so an expert saw `● Live` — a presence claim — where the honest answer is
 * a DURATION they are being credited for.
 *
 * ⚠⚠ **AND THE FIX IS LENS-CORRECT BY PARTY, WHICH IS THE WHOLE POINT.** The EXPERT sees
 * `{elapsed} counted` in amber while they wait, because their time IS being counted from
 * `max(scheduled_start, their join)`. The CLIENT correctly keeps `Not started` in exactly the
 * same room state, because **nothing is being charged until both parties are present**. Two
 * different true sentences about one meeting. Showing the client a running clock would be a
 * money claim that is false; showing the expert "Not started" is the misreading BAL-134 says
 * makes an expert leave at minute eight and forfeit a settlement they had already earned.
 *
 * ⚠ `viewerRole` IS THE SERVER'S OWN VERDICT (`authorizeMeetingParticipation`'s resolved side),
 * carried on the state payload. **NEVER a lens, never `activeMode`, never re-derived here.**
 *
 * ⚠ ELAPSED TIME ONLY — never a live cost meter (the BAL-403 precedent). The snapshot carries
 * durations and no money figure, so this function could not produce one if it tried.
 *
 * ⚠ IT READS NO CLOCK. `MeetingClockSlot` does the second-by-second ticking, drift-corrected
 * against `asOf`; this function only chooses WHICH of the four arms is true right now. That is
 * what makes the matrix below executable as a table-driven test.
 */

export interface TopBarClockInput {
  /**
   * The server mirror, or `null` when there isn't one yet.
   *
   * ⚠⚠ `null` IS A LIVE PATH, NOT A GUARD, AND IT HAS TWO REAL SOURCES: both GUEST mounts
   * (N5, fix-round-2 — corrected: NOT because they mount no route provider — both DO — but
   * because the state-polling route is member-only, so neither guest mount ever has a snapshot
   * to pass), and the member route in the window between joining and the first poll landing.
   */
  readonly snapshot: MeetingStateSnapshot | null;
}

/**
 * The chip's state, or `null` for "no server mirror — use the shipped local chrome".
 *
 * ⚠⚠ **`null` RATHER THAN `{ kind: 'not_started' }`, AND THE DIFFERENCE IS NOT COSMETIC.**
 * Collapsing the no-mirror case onto `not_started` would put "Not started" on a GUEST's screen
 * for the whole of a live call — a regression on a surface this ticket is not otherwise
 * touching — and would flash it on the member route for the ~1 render before the first poll
 * returns. `null` lets the frame keep its shipped `hasJoined ? live : not_started` fallback,
 * which is the honest answer when the only fact available is "I am in the room".
 */
/**
 * BAL-134 — ⚠⚠ **"AN EXPERT IS IN THE ROOM RIGHT NOW", NOT "AN EXPERT EVER JOINED".**
 *
 * The chip used to gate on `clocks.expertFirstJoinedAt !== null`, which is a fact about the PAST
 * and never becomes false again. An expert whose interval closed — a network drop, a killed tab,
 * a closed laptop — has an `expertPresentMs` that is FROZEN server-side, while the chip kept
 * ticking a locally-interpolated duration against `asOf` forever. That over-states credited time
 * in the one place this ticket exists to make honest, and §7.3's matrix says the opposite in
 * writing: *expert NOT present → `not_started`*.
 *
 * ⚠ `expertPresenceOpen === null` IS NOW A **DEPLOYMENT-SKEW PATH, NOT AN OUTSTANDING BUG.**
 * `apps/api` ships `presence.expertOpen` on the state payload, so on any deployed pair the branch
 * above is the one that runs and the defect described here is FIXED. `null` survives only because
 * apps/web (Vercel) and apps/api (Railway) deploy INDEPENDENTLY: a web release landing ahead of
 * the api's sees no `presence` block for that window.
 *
 * ⚠ AND THE FALLBACK IS DELIBERATELY THE OLD, OVER-STATING BEHAVIOUR. Treating "not sent" as
 * "not present" would blank the amber chip — the entire visible artifact of this ticket — for
 * every expert until the api caught up. Over-stating for one deploy window is the cheaper of the
 * two wrongs; it is not a correct answer, and it is not reachable once both sides are deployed.
 */
function isExpertPresent(snapshot: MeetingStateSnapshot): boolean {
  const { expertPresenceOpen, clocks } = snapshot;
  if (expertPresenceOpen !== null) return expertPresenceOpen;
  return clocks.expertFirstJoinedAt !== null;
}

export function resolveTopBarClock({ snapshot }: TopBarClockInput): MeetingClockState | null {
  if (snapshot === null) {
    return null;
  }

  const { status, viewerRole, clocks, asOf } = snapshot;

  // ⚠ TERMINAL FIRST. An ended or cancelled meeting has no running clock for anybody, and the
  // frame is on its way to the end-of-call screen; a frozen duration on the way out reads as a
  // clock that stopped by accident.
  if (status === 'ended' || status === 'cancelled') {
    return { kind: 'not_started' };
  }

  // ⚠ BOTH PARTIES PRESENT ⇒ THE BILLABLE SPAN IS RUNNING, and it is the same number for both
  // of them. This is the one arm where the two lenses agree.
  if (status === 'in_progress') {
    return { kind: 'billable', clocks, asOf };
  }

  // `scheduled` — nobody has opened an interval yet, so there is nothing counted for anyone.
  if (status !== 'waiting_for_participants') {
    return { kind: 'not_started' };
  }

  // ── `waiting_for_participants`: the 2×2 the patch exists for ─────────────────────────────
  //
  // ⚠ WRITTEN POSITIVE-FIRST (S7735: a negated condition with an `else` is the harder of the
  // two to read).
  if (viewerRole === 'expert' && isExpertPresent(snapshot)) {
    // THE EXPERT IS HERE AND THEIR CLOCK IS RUNNING. Amber, and it says "counted".
    //
    // ⚠ THE GATE IS NEVER A LOCAL "am I joined" FLAG, AND NEVER THE DURATION. `expertPresentMs`
    // is a SPAN from the first expert join, so it is `0` on the tick the expert arrives and
    // would be indistinguishable from "no expert yet" if this branched on the number.
    return { kind: 'counted', clocks, asOf };
  }

  // Either the viewer is the CLIENT — nothing is being charged, so `Not started` is the
  // correct and reassuring answer — or the viewer is an expert whose own interval has not
  // opened yet, in which case nothing is counted for anyone either.
  return { kind: 'not_started' };
}
