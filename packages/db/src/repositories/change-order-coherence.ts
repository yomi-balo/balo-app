/**
 * Change-order coherence guard (BAL-622).
 *
 * A PURE validator — no `db` import, no I/O — in the shape of `proposal-coherence.ts`.
 * `engagementChangeOrdersRepository` assembles the snapshot under the engagement lock and
 * calls {@link assertChangeOrderCoherent} at `send` and again at `approve`. Drafts are
 * deliberately unvalidated: an expert may save an incomplete change.
 *
 * The rules follow the pricing method. On a fixed-price project the money moves through
 * the order's `priceDeltaCents` and lines carry no estimates; on T&M the money follows the
 * estimates, so lines carry no values, there is no price delta, and every added or edited
 * milestone states its estimate.
 */

type CoherencePricingMethod = 'fixed' | 'tm';
type CoherenceLineOp = 'add' | 'edit' | 'remove';

/** The `rule` discriminant for a failed change-order coherence clause. */
export type ChangeOrderCoherenceRule =
  | 'tm_line_has_value' // tm ⇒ no line carries valueCents
  | 'tm_add_missing_estimate' // tm ⇒ every add line has estimatedMinutes > 0
  | 'tm_edit_missing_estimate' // tm ⇒ every edit line has estimatedMinutes present
  | 'fixed_line_has_estimate' // fixed ⇒ no line carries estimatedMinutes
  | 'price_delta_on_tm' // tm ⇒ priceDeltaCents is null
  | 'effective_price_negative' // fixed ⇒ current effective price + delta >= 0
  | 'line_target_not_live' // edit/remove ⇒ the target is a live milestone of the engagement
  | 'add_has_target' // add ⇒ no target milestone
  | 'duplicate_target' // a milestone is targeted by at most one line
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

export interface ChangeOrderCoherenceSnapshot {
  pricingMethod: CoherencePricingMethod;
  /** `price_cents` plus every approved delta, read under the engagement lock. */
  currentEffectivePriceCents: number;
  priceDeltaCents: number | null;
  note: string | null;
  lines: readonly ChangeOrderCoherenceLine[];
  /** The engagement's live milestone ids, read under the engagement lock. */
  liveMilestoneIds: ReadonlySet<string>;
}

function checkTargets(lines: readonly ChangeOrderCoherenceLine[], live: ReadonlySet<string>): void {
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
  if (snapshot.pricingMethod === 'fixed') {
    if (lines.some((l) => l.estimatedMinutes !== null)) {
      throw new ChangeOrderCoherenceError('fixed_line_has_estimate');
    }
    if (snapshot.currentEffectivePriceCents + (snapshot.priceDeltaCents ?? 0) < 0) {
      throw new ChangeOrderCoherenceError('effective_price_negative');
    }
    return;
  }
  if (snapshot.priceDeltaCents !== null) throw new ChangeOrderCoherenceError('price_delta_on_tm');
  if (lines.some((l) => l.valueCents !== null)) {
    throw new ChangeOrderCoherenceError('tm_line_has_value');
  }
  if (
    lines.some((l) => l.op === 'add' && (l.estimatedMinutes === null || l.estimatedMinutes <= 0))
  ) {
    throw new ChangeOrderCoherenceError('tm_add_missing_estimate');
  }
  if (lines.some((l) => l.op === 'edit' && l.estimatedMinutes === null)) {
    throw new ChangeOrderCoherenceError('tm_edit_missing_estimate');
  }
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
  checkTargets(snapshot.lines, snapshot.liveMilestoneIds);
  checkPricing(snapshot);
}
