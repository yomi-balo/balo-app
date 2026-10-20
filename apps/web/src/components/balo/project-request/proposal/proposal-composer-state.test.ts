import { describe, it, expect } from 'vitest';
import {
  COMPOSER_TARGET,
  INSTALLMENT_PRESETS,
  blankMilestone,
  computeTotalCents,
  emptyDraftState,
  hydrateMilestonePricing,
  installmentFieldId,
  installmentsSum,
  matchInstallmentPreset,
  milestoneAllocation,
  milestoneFieldId,
  nextDraftKey,
  presetInstallments,
  seedInstallments,
  summaryReadiness,
  toSavePayload,
  type ProposalDraftState,
  type ReadinessIssueId,
} from './proposal-composer-state';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';

/** A fully-ready Fixed draft (typed total = A$10,000 = 1,000,000 cents). */
function readyFixed(): ProposalDraftState {
  return {
    proposalId: 'p1',
    overview: '<p>Solid overview of the work.</p>',
    pricingMethod: 'fixed',
    currency: 'aud',
    timeframeWeeks: 6,
    exclusions: '',
    depositCents: null,
    rateCents: null,
    fixedPriceCents: 1_000_000,
    cadence: 'monthly',
    milestones: [
      {
        key: nextDraftKey(),
        title: 'Discovery',
        descriptionHtml: '<p>Workshops</p>',
        acceptanceCriteria: 'Signed-off plan',
        valueCents: 400_000,
        estimatedMinutes: null,
      },
      {
        key: nextDraftKey(),
        title: 'Build',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: 600_000,
        estimatedMinutes: null,
      },
    ],
    installments: [
      { key: nextDraftKey(), label: 'Upfront', pct: 40 },
      { key: nextDraftKey(), label: 'On delivery', pct: 60 },
    ],
    milestonePricingEnabled: true,
    documents: [],
  };
}

/** A fully-ready T&M draft. Effort 120 + 180 = 300 min (5h) × A$250/hr = A$1,250. */
function readyTm(): ProposalDraftState {
  const base = readyFixed();
  return {
    ...base,
    pricingMethod: 'tm',
    depositCents: 200_000,
    rateCents: 25_000,
    fixedPriceCents: null,
    cadence: 'fortnightly',
    milestones: base.milestones.map((m, i) => ({
      ...m,
      valueCents: null,
      estimatedMinutes: i === 0 ? 120 : 180,
    })),
    installments: [],
    milestonePricingEnabled: false,
  };
}

/** Indexed read that fails the test instead of yielding `undefined`. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`No item at index ${index}`);
  }
  return item;
}

/** The issue ids of `summaryReadiness`, in order. */
function issueIds(s: ProposalDraftState): ReadinessIssueId[] {
  return summaryReadiness(s).issues.map((i) => i.id);
}

describe('nextDraftKey', () => {
  it('returns unique keys', () => {
    expect(nextDraftKey()).not.toBe(nextDraftKey());
  });
});

describe('emptyDraftState', () => {
  it('starts fixed, with seeded installments and one blank milestone', () => {
    const s = emptyDraftState();
    expect(s.proposalId).toBeNull();
    expect(s.pricingMethod).toBe('fixed');
    expect(s.currency).toBe('aud');
    expect(s.installments).toHaveLength(2);
    expect(s.milestones).toHaveLength(1);
    expect(s.milestones[0]?.valueCents).toBeNull();
    expect(s.milestones[0]?.estimatedMinutes).toBeNull();
    expect(s.fixedPriceCents).toBeNull();
    expect(s.milestonePricingEnabled).toBe(false);
  });

  it('is not ready (empty overview + untitled milestone)', () => {
    expect(summaryReadiness(emptyDraftState()).ready).toBe(false);
  });
});

describe('seedInstallments', () => {
  it('seeds Upfront 30 / On delivery 70 (sums to 100)', () => {
    const seed = seedInstallments();
    expect(seed.map((i) => i.pct)).toEqual([30, 70]);
    expect(seed.reduce((a, i) => a + i.pct, 0)).toBe(100);
  });
});

describe('computeTotalCents — asymmetric by method (BAL-294)', () => {
  it('Fixed returns the typed fixedPriceCents (NOT the milestone valueCents sum)', () => {
    const s = readyFixed();
    // valueCents sum is also 1,000,000 here — diverge them to prove it uses the typed price.
    s.fixedPriceCents = 7_777_700;
    expect(computeTotalCents(s)).toBe(7_777_700);
  });

  it('Fixed with a null typed price is 0', () => {
    const s = readyFixed();
    s.fixedPriceCents = null;
    expect(computeTotalCents(s)).toBe(0);
  });

  it('T&M derives round(sum(estimatedMinutes)/60 × rateCents)', () => {
    const s = readyTm(); // 300 min = 5h × A$250/hr (25_000 cents) = A$1,250 = 125_000 cents
    expect(computeTotalCents(s)).toBe(125_000);
  });

  it('T&M treats a null effort as 0 minutes', () => {
    const s = readyTm();
    nth(s.milestones, 1).estimatedMinutes = null; // only 120 min = 2h × 25_000 = 50_000
    expect(computeTotalCents(s)).toBe(50_000);
  });

  it('T&M with a null rate derives 0', () => {
    const s = readyTm();
    s.rateCents = null;
    expect(computeTotalCents(s)).toBe(0);
  });

  it('T&M ignores the retained fixedPriceCents (derives from effort instead)', () => {
    const s = readyTm();
    s.fixedPriceCents = 9_999_900; // retained for restore-on-switch-back; not used under T&M
    expect(computeTotalCents(s)).toBe(125_000);
  });
});

describe('installmentsSum', () => {
  it('sums percentages', () => {
    expect(installmentsSum(readyFixed())).toBe(100);
  });
  it('is 0 for an empty list', () => {
    expect(installmentsSum(readyTm())).toBe(0);
  });
});

describe('summaryReadiness — Fixed', () => {
  it('is ready with an overview, titled milestones, a price and installments=100', () => {
    expect(summaryReadiness(readyFixed())).toEqual({ ready: true, issues: [] });
  });

  it('is ready with the milestone switch off and every amount null', () => {
    const s = readyFixed();
    s.milestonePricingEnabled = false;
    s.milestones.forEach((m) => {
      m.valueCents = null;
    });
    expect(summaryReadiness(s).ready).toBe(true);
  });

  it('flags an empty overview, targeting the overview field', () => {
    const s = readyFixed();
    s.overview = '<p></p>';
    expect(summaryReadiness(s).issues).toEqual([
      { id: 'overview', label: 'Add an overview', targetId: COMPOSER_TARGET.overview },
    ]);
  });

  it('flags no milestones, targeting the add-milestone control', () => {
    const s = readyFixed();
    s.milestones = [];
    s.milestonePricingEnabled = false;
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'milestones_none',
        label: 'Add at least one milestone',
        targetId: COMPOSER_TARGET.addMilestone,
      },
    ]);
  });

  it('flags one issue per untitled milestone with its 1-based position and field id', () => {
    const s = readyFixed();
    const first = nth(s.milestones, 0);
    const second = nth(s.milestones, 1);
    first.title = '   ';
    second.title = '';
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'milestone_title',
        label: 'Milestone 1 needs a title',
        targetId: milestoneFieldId('title', first.key),
      },
      {
        id: 'milestone_title',
        label: 'Milestone 2 needs a title',
        targetId: milestoneFieldId('title', second.key),
      },
    ]);
  });

  it.each([null, 0])('flags a project price of %s', (price) => {
    const s = readyFixed();
    s.fixedPriceCents = price;
    s.milestonePricingEnabled = false;
    expect(summaryReadiness(s).issues).toEqual([
      { id: 'price', label: 'Set your project price', targetId: COMPOSER_TARGET.fixedPrice },
    ]);
  });

  it('flags a single missing milestone amount by position (singular copy)', () => {
    const s = readyFixed();
    nth(s.milestones, 1).valueCents = null;
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'milestone_amounts',
        label: 'Set an amount for milestone 2',
        targetId: milestoneFieldId('amount', nth(s.milestones, 1).key),
      },
    ]);
  });

  it('treats a 0 amount as missing and uses the plural copy for several', () => {
    const s = readyFixed();
    nth(s.milestones, 0).valueCents = 0;
    nth(s.milestones, 1).valueCents = null;
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'milestone_amounts',
        label: 'Set amounts for 2 milestones',
        targetId: milestoneFieldId('amount', nth(s.milestones, 0).key),
      },
    ]);
  });

  it('raises no amounts or allocation issue while the switch is off', () => {
    const s = readyFixed();
    s.milestonePricingEnabled = false;
    nth(s.milestones, 0).valueCents = 1; // would be unbalanced if the switch were on
    nth(s.milestones, 1).valueCents = null;
    expect(summaryReadiness(s).ready).toBe(true);
  });

  it('flags amounts that do not add up to the price, targeting milestone 1', () => {
    const s = readyFixed();
    s.fixedPriceCents = 1_200_000;
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'milestone_allocation',
        label: 'Milestones add up to A$10,000, not A$12,000',
        targetId: milestoneFieldId('amount', nth(s.milestones, 0).key),
      },
    ]);
  });

  it('shows a cents-level mismatch exactly', () => {
    const s = readyFixed();
    s.fixedPriceCents = 1_000_050;
    expect(summaryReadiness(s).issues.map((i) => i.label)).toEqual([
      'Milestones add up to A$10,000, not A$10,000.50',
    ]);
  });

  it('flags a schedule with no payments, targeting the add-payment control', () => {
    const s = readyFixed();
    s.installments = [];
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'installments_none',
        label: 'Add a payment to the schedule',
        targetId: COMPOSER_TARGET.addInstallment,
      },
    ]);
  });

  it('flags installments that do not total 100 with the live sum, targeting payment 1', () => {
    const s = readyFixed();
    nth(s.installments, 1).pct = 50; // 40 + 50 = 90
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'installments_sum',
        label: 'Payments add up to 90%, not 100%',
        targetId: installmentFieldId('pct', nth(s.installments, 0).key),
      },
    ]);
  });

  it('orders issues overview, milestones, price, amounts, then payments', () => {
    const s = emptyDraftState();
    s.milestonePricingEnabled = true;
    s.installments = [];
    expect(issueIds(s)).toEqual([
      'overview',
      'milestone_title',
      'price',
      'milestone_amounts',
      'installments_none',
    ]);
  });
});

describe('summaryReadiness — T&M', () => {
  it('is ready with deposit + rate, no installments required', () => {
    expect(summaryReadiness(readyTm())).toEqual({ ready: true, issues: [] });
  });

  it('flags a missing deposit and rate', () => {
    const s = readyTm();
    s.depositCents = null;
    s.rateCents = null;
    const r = summaryReadiness(s);
    expect(r.issues).toEqual([
      { id: 'rate', label: 'Set your hourly rate', targetId: COMPOSER_TARGET.rate },
      {
        id: 'deposit',
        label: 'Set a deposit (it can be A$0)',
        targetId: COMPOSER_TARGET.deposit,
      },
    ]);
  });

  it('does NOT require installments or milestone values for T&M', () => {
    const s = readyTm();
    s.installments = [];
    nth(s.milestones, 0).valueCents = null;
    expect(summaryReadiness(s).ready).toBe(true);
  });

  it('flags a milestone missing an hour estimate (mirrors tm_missing_effort)', () => {
    const s = readyTm();
    nth(s.milestones, 1).estimatedMinutes = null;
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'milestone_hours',
        label: 'Add an hour estimate for milestone 2',
        targetId: milestoneFieldId('hours', nth(s.milestones, 1).key),
      },
    ]);
  });

  it('uses the plural copy and targets the first row when several estimates are missing', () => {
    const s = readyTm();
    s.milestones.forEach((m) => {
      m.estimatedMinutes = null;
    });
    expect(summaryReadiness(s).issues).toEqual([
      {
        id: 'milestone_hours',
        label: 'Add hour estimates for 2 milestones',
        targetId: milestoneFieldId('hours', nth(s.milestones, 0).key),
      },
    ]);
  });

  it('does not require a project price or milestone amounts', () => {
    const s = readyTm();
    s.fixedPriceCents = null;
    s.milestonePricingEnabled = true;
    expect(summaryReadiness(s).ready).toBe(true);
  });

  it('blocks T&M submit when there are no milestones (total 0)', () => {
    const s = readyTm();
    s.milestones = [];
    const r = summaryReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.issues.map((i) => i.id)).toContain('milestones_none');
  });
});

describe('toSavePayload — Fixed', () => {
  it('serialises header + replace-all lists, priceCents from the typed fixed price', () => {
    const payload = toSavePayload(readyFixed(), REQUEST_ID, RELATIONSHIP_ID);
    expect(payload.requestId).toBe(REQUEST_ID);
    expect(payload.relationshipId).toBe(RELATIONSHIP_ID);
    expect(payload.pricingMethod).toBe('fixed');
    expect(payload.priceCents).toBe(1_000_000);
    expect(payload.milestones).toHaveLength(2);
    expect(payload.milestones[0]?.valueCents).toBe(400_000);
    expect(payload.installments).toHaveLength(2);
    // T&M fields omitted under Fixed.
    expect(payload.depositCents).toBeUndefined();
    expect(payload.rateCents).toBeUndefined();
    expect(payload.cadence).toBeUndefined();
  });

  it('priceCents follows the typed price, decoupled from the milestone valueCents sum', () => {
    const s = readyFixed();
    s.fixedPriceCents = 2_500_000; // diverges from the 1,000,000 valueCents sum
    expect(toSavePayload(s, REQUEST_ID, RELATIONSHIP_ID).priceCents).toBe(2_500_000);
  });

  it('force-nulls estimatedMinutes under Fixed (effort is T&M-only)', () => {
    const s = readyFixed();
    nth(s.milestones, 0).estimatedMinutes = 120; // leftover from a prior T&M session
    const payload = toSavePayload(s, REQUEST_ID, RELATIONSHIP_ID);
    expect(payload.milestones.every((m) => m.estimatedMinutes === null)).toBe(true);
  });

  it('persists amounts only while "Price each milestone" is on', () => {
    const s = readyFixed();
    s.milestonePricingEnabled = false;
    const payload = toSavePayload(s, REQUEST_ID, RELATIONSHIP_ID);
    expect(payload.milestones.every((m) => m.valueCents === null)).toBe(true);
    expect(payload.priceCents).toBe(1_000_000);
    expect(payload).not.toHaveProperty('milestonePricingEnabled');
  });

  it('nulls empty optional milestone strings', () => {
    const payload = toSavePayload(readyFixed(), REQUEST_ID, RELATIONSHIP_ID);
    expect(payload.milestones[1]?.descriptionHtml).toBeNull();
    expect(payload.milestones[1]?.acceptanceCriteria).toBeNull();
  });

  it('omits exclusions and timeframe when absent', () => {
    const s = readyFixed();
    s.exclusions = '';
    s.timeframeWeeks = null;
    const payload = toSavePayload(s, REQUEST_ID, RELATIONSHIP_ID);
    expect(payload.exclusions).toBeUndefined();
    expect(payload.timeframeWeeks).toBeUndefined();
  });
});

describe('toSavePayload — T&M', () => {
  it('omits installments, nulls milestone values, includes deposit/rate/cadence', () => {
    const payload = toSavePayload(readyTm(), REQUEST_ID, RELATIONSHIP_ID);
    expect(payload.pricingMethod).toBe('tm');
    expect(payload.installments).toEqual([]);
    expect(payload.milestones.every((m) => m.valueCents === null)).toBe(true);
    expect(payload.depositCents).toBe(200_000);
    expect(payload.rateCents).toBe(25_000);
    expect(payload.cadence).toBe('fortnightly');
  });

  it('persists per-milestone estimatedMinutes and derives priceCents from effort × rate', () => {
    const payload = toSavePayload(readyTm(), REQUEST_ID, RELATIONSHIP_ID);
    expect(payload.milestones.map((m) => m.estimatedMinutes)).toEqual([120, 180]);
    // 300 min = 5h × A$250/hr = A$1,250 = 125,000 cents (the SINGLE write path).
    expect(payload.priceCents).toBe(125_000);
  });
});

describe('blankMilestone', () => {
  it('creates a unique, untitled row with a null amount', () => {
    const a = blankMilestone('fixed');
    expect(a).toMatchObject({
      title: '',
      descriptionHtml: '',
      acceptanceCriteria: '',
      valueCents: null,
      estimatedMinutes: null,
    });
    expect(blankMilestone('fixed').key).not.toBe(a.key);
  });

  it('starts at 0 minutes under T&M', () => {
    expect(blankMilestone('tm').estimatedMinutes).toBe(0);
  });
});

describe('hydrateMilestonePricing', () => {
  it('is true iff some milestone has a positive amount', () => {
    expect(hydrateMilestonePricing([{ valueCents: null }, { valueCents: 100 }])).toBe(true);
    expect(hydrateMilestonePricing([{ valueCents: 0 }, { valueCents: null }])).toBe(false);
    expect(hydrateMilestonePricing([])).toBe(false);
  });
});

describe('target id builders', () => {
  it('builds milestone and installment field ids', () => {
    expect(milestoneFieldId('amount', 'k1')).toBe('milestone-amount-k1');
    expect(milestoneFieldId('title', 'k1')).toBe('milestone-title-k1');
    expect(milestoneFieldId('hours', 'k1')).toBe('milestone-hours-k1');
    expect(installmentFieldId('pct', 'k2')).toBe('installment-pct-k2');
    expect(installmentFieldId('label', 'k2')).toBe('installment-label-k2');
  });

  it('exposes the fixed jump targets', () => {
    expect(COMPOSER_TARGET).toEqual({
      overview: 'proposal-overview',
      addMilestone: 'proposal-add-milestone',
      fixedPrice: 'proposal-fixed-price',
      addInstallment: 'proposal-add-installment',
      rate: 'proposal-rate',
      deposit: 'proposal-deposit',
      changeNote: 'proposal-change-note',
    });
  });
});

describe('installment presets', () => {
  const blank: Parameters<typeof presetInstallments>[1] = {
    milestones: [],
    milestonePricingEnabled: false,
  };
  const rows = (key: Parameters<typeof presetInstallments>[0], s = blank) =>
    presetInstallments(key, s).map((r) => [r.label, r.pct]);

  function milestonesWith(values: (number | null)[], titles?: string[]) {
    return values.map((v, i) => ({
      ...blankMilestone('fixed'),
      title: titles?.[i] ?? `M${i + 1}`,
      valueCents: v,
    }));
  }

  it('lists the presets in order', () => {
    expect(INSTALLMENT_PRESETS.map((p) => p.key)).toEqual([
      'one',
      '30-70',
      '50-50',
      '30-40-30',
      'per-milestone',
    ]);
  });

  it('builds the fixed presets', () => {
    expect(rows('one')).toEqual([['On delivery', 100]]);
    expect(rows('30-70')).toEqual([
      ['Upfront', 30],
      ['On delivery', 70],
    ]);
    expect(rows('50-50')).toEqual([
      ['Upfront', 50],
      ['On delivery', 50],
    ]);
    expect(rows('30-40-30')).toEqual([
      ['Upfront', 30],
      ['Midway', 40],
      ['On delivery', 30],
    ]);
  });

  it('seedInstallments equals the 30 / 70 preset', () => {
    expect(seedInstallments().map((r) => [r.label, r.pct])).toEqual(rows('30-70'));
  });

  it('returns fresh keys on every call', () => {
    const a = nth(presetInstallments('one', blank), 0);
    const b = nth(presetInstallments('one', blank), 0);
    expect(a.key).not.toBe(b.key);
  });

  it('per-milestone with no milestones is a single On delivery payment', () => {
    expect(rows('per-milestone')).toEqual([['On delivery', 100]]);
  });

  it('per-milestone splits evenly with the leftover points on the earliest rows', () => {
    const s = { milestones: milestonesWith([null, null, null]), milestonePricingEnabled: false };
    expect(rows('per-milestone', s)).toEqual([
      ['M1', 34],
      ['M2', 33],
      ['M3', 33],
    ]);
    const seven = {
      milestones: milestonesWith([null, null, null, null, null, null, null]),
      milestonePricingEnabled: false,
    };
    expect(presetInstallments('per-milestone', seven).map((r) => r.pct)).toEqual([
      15, 15, 14, 14, 14, 14, 14,
    ]);
  });

  it('per-milestone is proportional to the amounts when the switch is on and all are priced', () => {
    const s = {
      milestones: milestonesWith([100_000, 300_000, 600_000]),
      milestonePricingEnabled: true,
    };
    expect(rows('per-milestone', s)).toEqual([
      ['M1', 10],
      ['M2', 30],
      ['M3', 60],
    ]);
  });

  it('per-milestone proportional split gives leftover points to the biggest remainders', () => {
    const s = { milestones: milestonesWith([1, 1, 1]), milestonePricingEnabled: true };
    expect(presetInstallments('per-milestone', s).map((r) => r.pct)).toEqual([34, 33, 33]);
  });

  it('per-milestone proportional split totals 100 across seven equal milestones', () => {
    const s = {
      milestones: milestonesWith([100, 100, 100, 100, 100, 100, 100]),
      milestonePricingEnabled: true,
    };
    const pcts = presetInstallments('per-milestone', s).map((r) => r.pct);
    expect(pcts).toEqual([15, 15, 14, 14, 14, 14, 14]);
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('per-milestone proportional split gives a tiny milestone at least 1%', () => {
    const s = { milestones: milestonesWith([1, 1_000_000]), milestonePricingEnabled: true };
    const pcts = presetInstallments('per-milestone', s).map((r) => r.pct);
    expect(pcts).toEqual([1, 99]);
  });

  it('per-milestone falls back to even when an amount is missing or the switch is off', () => {
    const partial = { milestones: milestonesWith([100, null]), milestonePricingEnabled: true };
    expect(presetInstallments('per-milestone', partial).map((r) => r.pct)).toEqual([50, 50]);
    const off = { milestones: milestonesWith([100, 300]), milestonePricingEnabled: false };
    expect(presetInstallments('per-milestone', off).map((r) => r.pct)).toEqual([50, 50]);
  });

  it('per-milestone labels fall back to "Milestone n" for a blank title', () => {
    const s = {
      milestones: milestonesWith([null, null], ['  ', 'Build']),
      milestonePricingEnabled: false,
    };
    expect(rows('per-milestone', s).map(([label]) => label)).toEqual(['Milestone 1', 'Build']);
  });

  it('matchInstallmentPreset recognises each fixed preset after trimming labels', () => {
    for (const key of ['one', '30-70', '50-50', '30-40-30'] as const) {
      const installments = presetInstallments(key, blank).map((r) => ({
        ...r,
        label: `  ${r.label} `,
      }));
      expect(matchInstallmentPreset({ ...blank, installments })).toBe(key);
    }
  });

  it('matchInstallmentPreset matches per-milestone against the derived rows', () => {
    const milestones = milestonesWith([null, null, null]);
    const s = { milestones, milestonePricingEnabled: false };
    expect(
      matchInstallmentPreset({ ...s, installments: presetInstallments('per-milestone', s) })
    ).toBe('per-milestone');
  });

  it('matchInstallmentPreset returns null for a custom schedule', () => {
    const installments = [{ key: nextDraftKey(), label: 'Upfront', pct: 100 }];
    expect(matchInstallmentPreset({ ...blank, installments })).toBeNull();
  });
});

describe('milestoneAllocation', () => {
  const ms = (values: (number | null)[]) =>
    values.map((v) => ({ ...blankMilestone('fixed'), valueCents: v }));

  it('is no_price when the price is unset or zero', () => {
    expect(milestoneAllocation({ milestones: ms([100, 200]), fixedPriceCents: null })).toEqual({
      kind: 'no_price',
      allocatedCents: 300,
    });
    expect(milestoneAllocation({ milestones: ms([100]), fixedPriceCents: 0 }).kind).toBe(
      'no_price'
    );
  });

  it('is balanced when every milestone is priced and the sum equals the price', () => {
    expect(milestoneAllocation({ milestones: ms([400, 600]), fixedPriceCents: 1000 })).toEqual({
      kind: 'balanced',
      priceCents: 1000,
    });
  });

  it('is unbalanced with a positive diff when under-allocated', () => {
    expect(milestoneAllocation({ milestones: ms([400, 500]), fixedPriceCents: 1000 })).toEqual({
      kind: 'unbalanced',
      priceCents: 1000,
      allocatedCents: 900,
      diffCents: 100,
      allPriced: true,
    });
  });

  it('is unbalanced with a negative diff when over-allocated', () => {
    const r = milestoneAllocation({ milestones: ms([700, 600]), fixedPriceCents: 1000 });
    expect(r).toMatchObject({ kind: 'unbalanced', diffCents: -300, allPriced: true });
  });

  it('reports allPriced false when a milestone has no amount, even if the sum matches', () => {
    const r = milestoneAllocation({ milestones: ms([1000, null]), fixedPriceCents: 1000 });
    expect(r).toMatchObject({ kind: 'unbalanced', diffCents: 0, allPriced: false });
  });
});
