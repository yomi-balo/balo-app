import { describe, it, expect } from 'vitest';
import {
  emptyDraftState,
  seedInstallments,
  computeTotalCents,
  installmentsSum,
  summaryReadiness,
  toSavePayload,
  nextDraftKey,
  type ProposalDraftState,
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
  };
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
    expect(s.milestones[0]?.valueCents).toBe(0);
    expect(s.milestones[0]?.estimatedMinutes).toBeNull();
    expect(s.fixedPriceCents).toBeNull();
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
    s.milestones[1]!.estimatedMinutes = null; // only 120 min = 2h × 25_000 = 50_000
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
  it('is ready when overview, titled valued milestones, and installments=100', () => {
    expect(summaryReadiness(readyFixed())).toEqual({ ready: true, issues: [] });
  });

  it('flags an empty overview', () => {
    const s = readyFixed();
    s.overview = '<p></p>';
    const r = summaryReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('Add an overview');
  });

  it('flags a missing milestone title', () => {
    const s = readyFixed();
    s.milestones[0]!.title = '   ';
    const r = summaryReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('A milestone is missing a title');
  });

  it('flags no milestones', () => {
    const s = readyFixed();
    s.milestones = [];
    const r = summaryReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('Add at least one milestone');
  });

  it('flags installments that do not total 100 with the live sum', () => {
    const s = readyFixed();
    s.installments[1]!.pct = 50; // 40 + 50 = 90
    const r = summaryReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('Payment terms 90% — must total 100%');
  });

  it('flags a milestone with no value', () => {
    const s = readyFixed();
    s.milestones[1]!.valueCents = null;
    const r = summaryReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('A milestone is missing a value');
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
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('Add a deposit');
    expect(r.issues).toContain('Add an hourly rate');
  });

  it('does NOT require installments or milestone values for T&M', () => {
    const s = readyTm();
    s.installments = [];
    s.milestones[0]!.valueCents = null;
    expect(summaryReadiness(s).ready).toBe(true);
  });

  it('flags a milestone missing an effort estimate (mirrors tm_missing_effort)', () => {
    const s = readyTm();
    s.milestones[1]!.estimatedMinutes = null;
    const r = summaryReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('A milestone is missing an effort estimate');
  });

  it('blocks T&M submit when there are no milestones (total 0)', () => {
    const s = readyTm();
    s.milestones = [];
    const r = summaryReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('Add at least one milestone');
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
    s.milestones[0]!.estimatedMinutes = 120; // leftover from a prior T&M session
    const payload = toSavePayload(s, REQUEST_ID, RELATIONSHIP_ID);
    expect(payload.milestones.every((m) => m.estimatedMinutes === null)).toBe(true);
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
