import { describe, expect, it } from 'vitest';
import {
  assertChangeOrderCoherent,
  ChangeOrderCoherenceError,
  type ChangeOrderCoherenceLine,
  type ChangeOrderCoherenceRule,
  type ChangeOrderCoherenceSnapshot,
} from './change-order-coherence';

const LIVE_A = '00000000-0000-4000-8000-00000000000a';
const LIVE_B = '00000000-0000-4000-8000-00000000000b';
const GONE = '00000000-0000-4000-8000-0000000000ff';

function addLine(overrides: Partial<ChangeOrderCoherenceLine> = {}): ChangeOrderCoherenceLine {
  return {
    op: 'add',
    engagementMilestoneId: null,
    valueCents: null,
    estimatedMinutes: null,
    ...overrides,
  };
}

function editLine(overrides: Partial<ChangeOrderCoherenceLine> = {}): ChangeOrderCoherenceLine {
  return {
    op: 'edit',
    engagementMilestoneId: LIVE_A,
    valueCents: null,
    estimatedMinutes: null,
    ...overrides,
  };
}

function fixed(
  overrides: Partial<ChangeOrderCoherenceSnapshot> = {}
): ChangeOrderCoherenceSnapshot {
  return {
    pricingMethod: 'fixed',
    currentEffectivePriceCents: 500_000,
    priceDeltaCents: 100_000,
    note: 'Adds a migration.',
    lines: [addLine()],
    liveMilestoneIds: new Set([LIVE_A, LIVE_B]),
    ...overrides,
  };
}

function tm(overrides: Partial<ChangeOrderCoherenceSnapshot> = {}): ChangeOrderCoherenceSnapshot {
  return fixed({
    pricingMethod: 'tm',
    currentEffectivePriceCents: 0,
    priceDeltaCents: null,
    lines: [addLine({ estimatedMinutes: 120 }), editLine({ estimatedMinutes: 60 })],
    ...overrides,
  });
}

function ruleOf(snapshot: ChangeOrderCoherenceSnapshot): ChangeOrderCoherenceRule | null {
  try {
    assertChangeOrderCoherent(snapshot);
    return null;
  } catch (error) {
    if (error instanceof ChangeOrderCoherenceError) return error.rule;
    throw error;
  }
}

describe('assertChangeOrderCoherent', () => {
  it('accepts a coherent fixed-price and T&M order', () => {
    expect(ruleOf(fixed())).toBeNull();
    expect(ruleOf(tm())).toBeNull();
    expect(ruleOf(fixed({ lines: [], priceDeltaCents: -500_000 }))).toBeNull();
  });

  it.each<[ChangeOrderCoherenceRule, ChangeOrderCoherenceSnapshot]>([
    ['note_missing', fixed({ note: null })],
    ['note_missing', fixed({ note: '  ' })],
    ['empty_change', fixed({ lines: [], priceDeltaCents: 0 })],
    ['empty_change', fixed({ lines: [], priceDeltaCents: null })],
    ['add_has_target', fixed({ lines: [addLine({ engagementMilestoneId: LIVE_A })] })],
    ['line_target_not_live', fixed({ lines: [editLine({ engagementMilestoneId: GONE })] })],
    ['line_target_not_live', fixed({ lines: [editLine({ engagementMilestoneId: null })] })],
    ['duplicate_target', fixed({ lines: [editLine(), { ...editLine(), op: 'remove' }] })],
    ['fixed_line_has_estimate', fixed({ lines: [addLine({ estimatedMinutes: 60 })] })],
    ['effective_price_negative', fixed({ priceDeltaCents: -500_001 })],
    [
      'effective_price_negative',
      tm({ currentEffectivePriceCents: 900_000, priceDeltaCents: -900_001 }),
    ],
    ['tm_line_has_value', tm({ lines: [addLine({ estimatedMinutes: 60, valueCents: 1 })] })],
    ['tm_add_missing_estimate', tm({ lines: [addLine()] })],
    ['tm_add_missing_estimate', tm({ lines: [addLine({ estimatedMinutes: 0 })] })],
    ['tm_edit_missing_estimate', tm({ lines: [editLine()] })],
  ])('rejects %s', (rule, snapshot) => {
    expect(ruleOf(snapshot)).toBe(rule);
  });

  it('accepts a T&M cap delta, raising or lowering the cap to zero', () => {
    expect(
      ruleOf(tm({ currentEffectivePriceCents: 900_000, priceDeltaCents: 300_000 }))
    ).toBeNull();
    expect(
      ruleOf(tm({ currentEffectivePriceCents: 900_000, priceDeltaCents: -900_000 }))
    ).toBeNull();
    expect(
      ruleOf(tm({ lines: [], currentEffectivePriceCents: 900_000, priceDeltaCents: 1 }))
    ).toBeNull();
  });

  it('allows a remove line with no estimate on T&M', () => {
    expect(ruleOf(tm({ lines: [{ ...editLine(), op: 'remove' }] }))).toBeNull();
  });
});
