import { describe, it, expect } from 'vitest';
import {
  emptyDraftState,
  seedInstallments,
  plainTextLength,
  computeTotalCents,
  installmentsSum,
  summaryReadiness,
  toSavePayload,
  nextDraftKey,
  type ProposalDraftState,
} from './proposal-composer-state';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';

/** A fully-ready Fixed draft. */
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
    cadence: 'monthly',
    milestones: [
      {
        key: nextDraftKey(),
        title: 'Discovery',
        descriptionHtml: '<p>Workshops</p>',
        acceptanceCriteria: 'Signed-off plan',
        valueCents: 400_000,
      },
      {
        key: nextDraftKey(),
        title: 'Build',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: 600_000,
      },
    ],
    installments: [
      { key: nextDraftKey(), label: 'Upfront', pct: 40 },
      { key: nextDraftKey(), label: 'On delivery', pct: 60 },
    ],
    documents: [],
  };
}

/** A fully-ready T&M draft. */
function readyTm(): ProposalDraftState {
  return {
    ...readyFixed(),
    pricingMethod: 'tm',
    depositCents: 200_000,
    rateCents: 25_000,
    cadence: 'fortnightly',
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

describe('plainTextLength', () => {
  it('strips tags and nbsp', () => {
    expect(plainTextLength('<p>Hello&nbsp;world</p>')).toBe(11);
  });
  it('is 0 for tag-only / whitespace HTML', () => {
    expect(plainTextLength('<p></p>')).toBe(0);
    expect(plainTextLength('<p>   </p>')).toBe(0);
    expect(plainTextLength('')).toBe(0);
  });
});

describe('computeTotalCents', () => {
  it('sums milestone values (null treated as 0)', () => {
    const s = readyFixed();
    expect(computeTotalCents(s)).toBe(1_000_000);
  });
  it('handles a null value as 0', () => {
    const s = readyFixed();
    s.milestones[1]!.valueCents = null;
    expect(computeTotalCents(s)).toBe(400_000);
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
});

describe('toSavePayload — Fixed', () => {
  it('serialises header + replace-all lists, deriving priceCents from milestones', () => {
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
});
