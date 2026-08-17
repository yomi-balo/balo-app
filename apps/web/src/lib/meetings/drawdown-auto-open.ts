import type { DrawdownKey } from '@balo/shared/credit';
import type { MeetingPanelId } from './meeting-panels';

/**
 * BAL-403 — the in-call BALANCE slot's auto-open ladder.
 *
 * ── ⚠⚠ THE ADR THIS SCOPES, NOT REVERSES — SEE `in-call-balance-panel.tsx`'S DOCBLOCK ──────
 *
 * `balo-in-meeting-ui.jsx:50`'s baked-in decision is "elapsed-time only in-call (no live cost
 * meter)". This ladder is the approved mitigation (Yomi, 2026-08-16): a `healthy` session adds
 * NOTHING to the chrome — no badge, no auto-open, no countdown — so for the entire healthy
 * duration of every call the surface stays byte-for-byte what the prototype specifies. Only a
 * genuine funding interruption escalates, and even then the panel never shows a cost (see
 * `deriveDrawdownState`'s module docblock).
 *
 * ── ⚠ PURE, DELIBERATELY. No React, no timers, no `lens` — unit-testable with no DOM. ────────
 *
 * ### The rank ladder
 *
 * `healthy → 0, low → 1, near → 2, grace → 3, wrap → 4, end → 5` — over the REAL six-member
 * `DrawdownKey` union. `Record<DrawdownKey, number>` is total, so a seventh key added later is a
 * compile error here rather than a silently-unranked escalation.
 *
 * ### The rules
 *
 * 1. **Never on healthy.** `rank === 0` never auto-opens and never badges.
 * 2. **Only on escalation.** The frame keeps `highestRank` (initial `0`) in a ref. This function
 *    only ACTS when `rank(next) > highestRank`.
 * 3. **Never steal an open panel.** On an escalation: `openPanel === null` ⇒ `'open'`;
 *    `openPanel !== null` (People / Files / Chat) ⇒ `'badge'` — the anti-yank rule. A member
 *    mid-sentence in Chat is not thrown out of it.
 * 3a. **⚠⚠ FIX ROUND 1 (W4) — `openPanel === 'balance'` IS NOT A STEAL.** The toolbar button
 *     used to announce "Balance, needs attention" while the member was already looking at that
 *     exact panel, because `'badge'` was returned for ANY non-null `openPanel`. When Balance is
 *     already open there is nothing to defer: the panel is already showing the escalated state,
 *     so the decision is `'none'` — `highestRank` still advances (there is nothing left to
 *     re-decide at this rank), it just is not a `'badge'` or an `'open'`.
 * 4. **The badge is the deferred open.** Clearing it is the FRAME's job (whenever the Balance
 *    panel is opened, by any route) — this function only ever RAISES the flag.
 * 5. **A manual close is respected.** Closing the panel does not re-open it for the same rank;
 *    only the next escalation (rule 2) can act again — automatic, because `highestRank` already
 *    sits at the current rank.
 * 6. **De-escalation re-arms.** `rank(next) < highestRank` (e.g. an admin tops up, `grace` →
 *    `healthy`) resets `highestRank` down to `rank(next)` with no decision, so a LATER
 *    re-escalation auto-opens again — a second drain is a second event worth surfacing.
 * 7. **Not before the first successful poll.** `key === null` ⇒ `'none'`, `highestRank`
 *    unchanged.
 * 8. **Not on a terminal frame.** The frame's own effect already closes every panel when
 *    `isTerminal`; this must not fight it. `isTerminal` ⇒ `'none'`, `highestRank` unchanged.
 */

const RANK: Record<DrawdownKey, number> = {
  healthy: 0,
  low: 1,
  near: 2,
  grace: 3,
  wrap: 4,
  end: 5,
};

export type AutoOpenDecision = 'open' | 'badge' | 'none';

export interface ResolveAutoOpenInput {
  /** The last successfully-polled key, or `null` before the first poll lands. */
  readonly key: DrawdownKey | null;
  /** The highest rank seen so far this call, held in a ref by the frame. */
  readonly highestRank: number;
  /** Which panel (if any) is open right now. */
  readonly openPanel: MeetingPanelId | null;
  readonly isTerminal: boolean;
}

export interface ResolveAutoOpenResult {
  readonly decision: AutoOpenDecision;
  /** The frame writes this straight back into its ref. */
  readonly highestRank: number;
}

export function resolveAutoOpen({
  key,
  highestRank,
  openPanel,
  isTerminal,
}: ResolveAutoOpenInput): ResolveAutoOpenResult {
  if (key === null || isTerminal) {
    return { decision: 'none', highestRank };
  }

  const rank = RANK[key];

  if (rank < highestRank) {
    // Rule 6 — de-escalation re-arms, but is never itself a decision.
    return { decision: 'none', highestRank: rank };
  }

  if (rank === highestRank) {
    // Rule 5 (steady state / re-poll at the same rank) — including `healthy` forever.
    return { decision: 'none', highestRank };
  }

  // rank > highestRank ⇒ a genuine escalation (rule 2). `rank` is never 0 here, because
  // `highestRank` starts at 0 and `healthy` (rank 0) can never be `>` it.
  //
  // ⚠ RULE 3a (W4) — `'balance'` IS NOT A STEAL: the panel already shows this escalation.
  // `if`/`else`, not a nested ternary (SonarCloud S3358).
  let decision: AutoOpenDecision;
  if (openPanel === null) {
    decision = 'open';
  } else if (openPanel === 'balance') {
    decision = 'none';
  } else {
    decision = 'badge';
  }
  return { decision, highestRank: rank };
}
