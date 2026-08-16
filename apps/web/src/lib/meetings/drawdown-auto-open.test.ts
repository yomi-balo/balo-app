import { describe, expect, it } from 'vitest';
import type { DrawdownKey } from '@balo/shared/credit';
import { resolveAutoOpen } from './drawdown-auto-open';

const ALL_KEYS: readonly DrawdownKey[] = ['healthy', 'low', 'near', 'grace', 'wrap', 'end'];

describe('resolveAutoOpen — the rank ladder', () => {
  it('⚠ a totality test over all six DrawdownKey members — none is silently unranked', () => {
    for (const key of ALL_KEYS) {
      const result = resolveAutoOpen({ key, highestRank: 0, openPanel: null, isTerminal: false });
      expect(['open', 'badge', 'none']).toContain(result.decision);
      expect(Number.isInteger(result.highestRank)).toBe(true);
    }
  });

  it('rule 1 — healthy never auto-opens and never badges', () => {
    const result = resolveAutoOpen({
      key: 'healthy',
      highestRank: 0,
      openPanel: null,
      isTerminal: false,
    });
    expect(result).toEqual({ decision: 'none', highestRank: 0 });
  });

  it('rule 1 — healthy stays silent even with another panel open', () => {
    const result = resolveAutoOpen({
      key: 'healthy',
      highestRank: 0,
      openPanel: 'chat',
      isTerminal: false,
    });
    expect(result.decision).toBe('none');
  });

  it('rule 2/3 — first escalation with NO panel open ⇒ open', () => {
    const result = resolveAutoOpen({
      key: 'low',
      highestRank: 0,
      openPanel: null,
      isTerminal: false,
    });
    expect(result).toEqual({ decision: 'open', highestRank: 1 });
  });

  it('rule 3 — the SAME escalation with Chat open ⇒ badge, never a switch', () => {
    const result = resolveAutoOpen({
      key: 'low',
      highestRank: 0,
      openPanel: 'chat',
      isTerminal: false,
    });
    expect(result).toEqual({ decision: 'badge', highestRank: 1 });
  });

  it('⚠⚠ rule 3a (W4) — an escalation while Balance is ALREADY open is not a steal: none, not badge', () => {
    const result = resolveAutoOpen({
      key: 'near',
      highestRank: 1,
      openPanel: 'balance',
      isTerminal: false,
    });
    // `highestRank` still advances — there is nothing left to re-decide at this rank — but the
    // decision must not tell the person "needs attention" about the panel they are looking at.
    expect(result).toEqual({ decision: 'none', highestRank: 2 });
  });

  it('rule 5 — a re-poll at the SAME rank decides nothing again', () => {
    const result = resolveAutoOpen({
      key: 'low',
      highestRank: 1,
      openPanel: null,
      isTerminal: false,
    });
    expect(result).toEqual({ decision: 'none', highestRank: 1 });
  });

  it('rule 5 — manual close then the same rank stays quiet (highestRank already there)', () => {
    // Escalate once...
    const first = resolveAutoOpen({
      key: 'low',
      highestRank: 0,
      openPanel: null,
      isTerminal: false,
    });
    expect(first.decision).toBe('open');
    // ...person closes the panel (openPanel becomes null again), same rank re-polled.
    const second = resolveAutoOpen({
      key: 'low',
      highestRank: first.highestRank,
      openPanel: null,
      isTerminal: false,
    });
    expect(second).toEqual({ decision: 'none', highestRank: 1 });
  });

  it('rule 6 — de-escalate then re-escalate auto-opens AGAIN', () => {
    // grace (rank 3), highestRank already at 3 from an earlier escalation.
    const deescalate = resolveAutoOpen({
      key: 'healthy',
      highestRank: 3,
      openPanel: null,
      isTerminal: false,
    });
    expect(deescalate).toEqual({ decision: 'none', highestRank: 0 });

    const reescalate = resolveAutoOpen({
      key: 'grace',
      highestRank: deescalate.highestRank,
      openPanel: null,
      isTerminal: false,
    });
    expect(reescalate).toEqual({ decision: 'open', highestRank: 3 });
  });

  it('rule 7 — state === null (no poll yet) decides nothing', () => {
    const result = resolveAutoOpen({
      key: null,
      highestRank: 0,
      openPanel: null,
      isTerminal: false,
    });
    expect(result).toEqual({ decision: 'none', highestRank: 0 });
  });

  it('rule 7 — key === null never overwrites a non-zero highestRank', () => {
    const result = resolveAutoOpen({
      key: null,
      highestRank: 3,
      openPanel: null,
      isTerminal: false,
    });
    expect(result).toEqual({ decision: 'none', highestRank: 3 });
  });

  it('rule 8 — a terminal frame decides nothing, even mid-escalation', () => {
    const result = resolveAutoOpen({
      key: 'wrap',
      highestRank: 0,
      openPanel: null,
      isTerminal: true,
    });
    expect(result).toEqual({ decision: 'none', highestRank: 0 });
  });

  it('escalates step by step across the full ladder, opening at each new rank', () => {
    let highestRank = 0;
    const order: DrawdownKey[] = ['low', 'near', 'grace', 'wrap', 'end'];
    for (const key of order) {
      const result = resolveAutoOpen({ key, highestRank, openPanel: null, isTerminal: false });
      expect(result.decision).toBe('open');
      highestRank = result.highestRank;
    }
    expect(highestRank).toBe(5);
  });
});
