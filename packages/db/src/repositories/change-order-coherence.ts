/**
 * Change-order coherence guard (BAL-622).
 *
 * A PURE validator — no `db` import, no I/O — in the shape of `proposal-coherence.ts`.
 * `engagementChangeOrdersRepository` assembles the snapshot under the engagement lock and
 * calls {@link assertChangeOrderCoherent} at `send` and again at `approve`. Drafts are
 * deliberately unvalidated: an expert may save an incomplete change.
 *
 * The rules follow the pricing method. On a fixed-price project the order's
 * `priceDeltaCents` moves the price and lines carry no estimates; on T&M it moves the cap,
 * lines carry no values, and every added or edited milestone states its estimate. On both,
 * the effective price (or cap) after the delta stays at or above zero. On T&M, an order that
 * lowers the cap may not take it below the value of the time already logged; a raise is always
 * allowed, since logging is not blocked by the cap and a raise moves toward coherence. A
 * milestone with live time logged against it cannot be removed, and an order that changes a
 * milestone's estimate may not set it below the time already logged on it.
 */

import { loggedValueCents } from '@balo/shared/engagements';

type CoherencePricingMethod = 'fixed' | 'tm';
type CoherenceLineOp = 'add' | 'edit' | 'remove';

/** The `rule` discriminant for a failed change-order coherence clause. */
export type ChangeOrderCoherenceRule =
  | 'tm_line_has_value' // tm ⇒ no line carries valueCents
  | 'tm_add_missing_estimate' // tm ⇒ every add line has estimatedMinutes > 0
  | 'tm_edit_missing_estimate' // tm ⇒ every edit line has estimatedMinutes present
  | 'fixed_line_has_estimate' // fixed ⇒ no line carries estimatedMinutes
  | 'effective_price_negative' // current effective price (or cap) + delta >= 0
  | 'cap_below_logged' // tm ∧ delta < 0 ⇒ new cap >= value of the time logged
  | 'line_target_not_live' // edit/remove ⇒ the target is a live milestone of the engagement
  | 'add_has_target' // add ⇒ no target milestone
  | 'duplicate_target' // a milestone is targeted by at most one line
  | 'remove_has_logged_time' // remove ⇒ the target has no live time logged
  | 'estimate_below_logged' // tm ∧ edit changes the estimate ⇒ new estimate >= time logged
  | 'note_missing' // the expert's note is present and non-blank
  | 'empty_change'; // at least one line, or a non-zero price delta

export class ChangeOrderCoherenceError extends Error {
  constructor(public readonly rule: ChangeOrderCoherenceRule) {
    super(`Change order is not coherent: ${rule}`);
    this.name = 'ChangeOrderCoherenceError';
  }
}

export interface ChangeOrderCoherenceLine {
  op: CoherenceLineOp;
  engagementMilestoneId: string | null;
  valueCents: number | null;
  estimatedMinutes: number | null;
}

/** A live milestone of the engagement, as read under the engagement lock. */
export interface CoherenceLiveMilestone {
  estimatedMinutes: number | null;
  /** Minutes of live time logged against it. */
  loggedMinutes: number;
}

export interface ChangeOrderCoherenceSnapshot {
  pricingMethod: CoherencePricingMethod;
  /**
   * `price_cents` (the price, or the cap on T&M) plus every approved delta, read under the
   * engagement lock.
   */
  currentEffectivePriceCents: number;
  priceDeltaCents: number | null;
  note: string | null;
  lines: readonly ChangeOrderCoherenceLine[];
  /** The engagement's live milestones by id, read under the engagement lock. */
  liveMilestones: ReadonlyMap<string, CoherenceLiveMilestone>;
  /** Minutes of live time logged on the engagement, read under the engagement lock. */
  loggedMinutes: number;
  /** The expert-side hourly rate (T&M); null when the project has none. */
  rateCents: number | null;
}

function checkTargets(
  lines: readonly ChangeOrderCoherenceLine[],
  live: ReadonlyMap<string, CoherenceLiveMilestone>
): void {
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.op === 'add') {
      if (line.engagementMilestoneId !== null)
        throw new ChangeOrderCoherenceError('add_has_target');
      continue;
    }
    const target = line.engagementMilestoneId;
    if (target === null || !live.has(target)) {
      throw new ChangeOrderCoherenceError('line_target_not_live');
    }
    if (seen.has(target)) throw new ChangeOrderCoherenceError('duplicate_target');
    seen.add(target);
  }
}

function checkPricing(snapshot: ChangeOrderCoherenceSnapshot): void {
  const { lines } = snapshot;
  if (snapshot.currentEffectivePriceCents + (snapshot.priceDeltaCents ?? 0) < 0) {
    throw new ChangeOrderCoherenceError('effective_price_negative');
  }
  if (snapshot.pricingMethod === 'fixed') {
    if (lines.some((l) => l.estimatedMinutes !== null)) {
      throw new ChangeOrderCoherenceError('fixed_line_has_estimate');
    }
    return;
  }
  if (lines.some((l) => l.valueCents !== null)) {
    throw new ChangeOrderCoherenceError('tm_line_has_value');
  }
  const delta = snapshot.priceDeltaCents;
  if (
    delta !== null &&
    delta < 0 &&
    snapshot.currentEffectivePriceCents + delta <
      loggedValueCents(snapshot.loggedMinutes, snapshot.rateCents)
  ) {
    throw new ChangeOrderCoherenceError('cap_below_logged');
  }
  if (
    lines.some((l) => l.op === 'add' && (l.estimatedMinutes === null || l.estimatedMinutes <= 0))
  ) {
    throw new ChangeOrderCoherenceError('tm_add_missing_estimate');
  }
  if (lines.some((l) => l.op === 'edit' && l.estimatedMinutes === null)) {
    throw new ChangeOrderCoherenceError('tm_edit_missing_estimate');
  }
  if (lines.some((l) => setsEstimateBelowLogged(l, snapshot.liveMilestones))) {
    throw new ChangeOrderCoherenceError('estimate_below_logged');
  }
}

/**
 * An edit that changes a milestone's estimate to less than the time already logged on it. An
 * edit that leaves the estimate as it is passes, so a milestone already over its estimate can
 * still be renamed or redescribed.
 */
function setsEstimateBelowLogged(
  line: ChangeOrderCoherenceLine,
  live: ReadonlyMap<string, CoherenceLiveMilestone>
): boolean {
  if (line.op !== 'edit' || line.engagementMilestoneId === null || line.estimatedMinutes === null) {
    return false;
  }
  const target = live.get(line.engagementMilestoneId);
  return (
    target !== undefined &&
    line.estimatedMinutes !== target.estimatedMinutes &&
    line.estimatedMinutes < target.loggedMinutes
  );
}

/**
 * Assert a change order is fit to send (and, re-checked, to approve). Throws
 * {@link ChangeOrderCoherenceError} carrying the first failed rule.
 */
export function assertChangeOrderCoherent(snapshot: ChangeOrderCoherenceSnapshot): void {
  if (snapshot.note === null || snapshot.note.trim() === '') {
    throw new ChangeOrderCoherenceError('note_missing');
  }
  if (snapshot.lines.length === 0 && (snapshot.priceDeltaCents ?? 0) === 0) {
    throw new ChangeOrderCoherenceError('empty_change');
  }
  checkTargets(snapshot.lines, snapshot.liveMilestones);
  if (
    snapshot.lines.some(
      (l) =>
        l.op === 'remove' &&
        l.engagementMilestoneId !== null &&
        (snapshot.liveMilestones.get(l.engagementMilestoneId)?.loggedMinutes ?? 0) > 0
    )
  ) {
    throw new ChangeOrderCoherenceError('remove_has_logged_time');
  }
  checkPricing(snapshot);
}
