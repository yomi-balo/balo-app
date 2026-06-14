import { describe, it, expect } from 'vitest';
import {
  assertProposalCoherent,
  assertEngagementTermsCoherent,
  ProposalCoherenceError,
  EngagementTermsCoherenceError,
  type ProposalCoherenceSnapshot,
  type EngagementTermsSnapshot,
} from './proposal-coherence';

/**
 * Unit table tests for the pure coherence validator (BAL-293). Mocks nothing —
 * `proposal-coherence.ts` has no `db` import and no I/O. Price/percent math is the
 * "ALWAYS test" category. One `describe` per clause: a passing case AND a failing
 * case asserting both the error CLASS and the caught `.rule` discriminant.
 */

/** A fully-coherent `fixed` snapshot — override per-case via the spread. */
function fixedSnapshot(
  overrides: Partial<ProposalCoherenceSnapshot> = {}
): ProposalCoherenceSnapshot {
  return {
    pricingMethod: 'fixed',
    priceCents: 100_000,
    currency: 'aud',
    depositCents: null,
    rateCents: null,
    cadence: null,
    milestones: [{ valueCents: 60_000 }, { valueCents: 40_000 }],
    installments: [{ pct: 50 }, { pct: 50 }],
    ...overrides,
  };
}

/** A fully-coherent `tm` snapshot — override per-case via the spread. */
function tmSnapshot(overrides: Partial<ProposalCoherenceSnapshot> = {}): ProposalCoherenceSnapshot {
  return {
    pricingMethod: 'tm',
    priceCents: 100_000,
    currency: 'aud',
    depositCents: 25_000,
    rateCents: 18_000,
    cadence: 'monthly',
    milestones: [{ valueCents: null }, { valueCents: null }],
    installments: [],
    ...overrides,
  };
}

/** Run the assert and return the caught `ProposalCoherenceError` (fails if none). */
function catchProposalError(snapshot: ProposalCoherenceSnapshot): ProposalCoherenceError {
  try {
    assertProposalCoherent(snapshot);
  } catch (e) {
    if (e instanceof ProposalCoherenceError) return e;
    throw e;
  }
  throw new Error('expected assertProposalCoherent to throw, but it did not');
}

describe('assertProposalCoherent — price_negative', () => {
  it('throws on a negative price (fixed)', () => {
    const err = catchProposalError(fixedSnapshot({ priceCents: -1 }));
    expect(err).toBeInstanceOf(ProposalCoherenceError);
    expect(err.rule).toBe('price_negative');
  });

  it('throws on a negative price (tm)', () => {
    expect(catchProposalError(tmSnapshot({ priceCents: -1 })).rule).toBe('price_negative');
  });

  it('passes at price 0', () => {
    expect(() =>
      assertProposalCoherent(fixedSnapshot({ priceCents: 0, milestones: [{ valueCents: 0 }] }))
    ).not.toThrow();
  });
});

describe('assertProposalCoherent — deposit_negative', () => {
  it('throws on a negative deposit', () => {
    expect(catchProposalError(tmSnapshot({ depositCents: -1 })).rule).toBe('deposit_negative');
  });

  it('passes when the deposit is null', () => {
    expect(() => assertProposalCoherent(fixedSnapshot({ depositCents: null }))).not.toThrow();
  });

  it('passes when the deposit is 0', () => {
    expect(() => assertProposalCoherent(fixedSnapshot({ depositCents: 0 }))).not.toThrow();
  });
});

describe('assertProposalCoherent — tm_missing_rate', () => {
  it('throws when tm has a null rate', () => {
    expect(catchProposalError(tmSnapshot({ rateCents: null })).rule).toBe('tm_missing_rate');
  });

  it('throws when tm has a negative rate', () => {
    expect(catchProposalError(tmSnapshot({ rateCents: -1 })).rule).toBe('tm_missing_rate');
  });

  it('throws when tm has a null cadence', () => {
    expect(catchProposalError(tmSnapshot({ cadence: null })).rule).toBe('tm_missing_rate');
  });

  it('passes when tm has rate 0 and a cadence present', () => {
    expect(() =>
      assertProposalCoherent(tmSnapshot({ rateCents: 0, cadence: 'fortnightly' }))
    ).not.toThrow();
  });
});

describe('assertProposalCoherent — fixed_requires_installments', () => {
  it('throws when a fixed proposal has no installments', () => {
    expect(catchProposalError(fixedSnapshot({ installments: [] })).rule).toBe(
      'fixed_requires_installments'
    );
  });

  it('passes with a single 100% installment', () => {
    expect(() =>
      assertProposalCoherent(
        fixedSnapshot({ installments: [{ pct: 100 }], milestones: [{ valueCents: 100_000 }] })
      )
    ).not.toThrow();
  });
});

describe('assertProposalCoherent — installments_not_100', () => {
  it('throws when the pct sum is 90 (under 100)', () => {
    expect(
      catchProposalError(fixedSnapshot({ installments: [{ pct: 60 }, { pct: 30 }] })).rule
    ).toBe('installments_not_100');
  });

  it('throws when the pct sum is 101 (over 100)', () => {
    expect(
      catchProposalError(fixedSnapshot({ installments: [{ pct: 60 }, { pct: 41 }] })).rule
    ).toBe('installments_not_100');
  });

  it('passes when the pct sum is exactly 100 (60/40)', () => {
    expect(() =>
      assertProposalCoherent(fixedSnapshot({ installments: [{ pct: 60 }, { pct: 40 }] }))
    ).not.toThrow();
  });

  it('passes when the pct sum is exactly 100 (50/50)', () => {
    expect(() =>
      assertProposalCoherent(fixedSnapshot({ installments: [{ pct: 50 }, { pct: 50 }] }))
    ).not.toThrow();
  });
});

describe('assertProposalCoherent — tm_has_installments', () => {
  it('throws when a tm proposal carries installments', () => {
    expect(catchProposalError(tmSnapshot({ installments: [{ pct: 100 }] })).rule).toBe(
      'tm_has_installments'
    );
  });

  it('passes when a tm proposal has no installments', () => {
    expect(() => assertProposalCoherent(tmSnapshot({ installments: [] }))).not.toThrow();
  });
});

describe('assertProposalCoherent — fixed_milestone_values_exceed_price', () => {
  it('throws when milestone values exceed the price', () => {
    expect(
      catchProposalError(
        fixedSnapshot({
          priceCents: 100_000,
          milestones: [{ valueCents: 100_001 }],
          installments: [{ pct: 100 }],
        })
      ).rule
    ).toBe('fixed_milestone_values_exceed_price');
  });

  it('passes when milestone values equal the price', () => {
    expect(() =>
      assertProposalCoherent(
        fixedSnapshot({
          priceCents: 100_000,
          milestones: [{ valueCents: 60_000 }, { valueCents: 40_000 }],
          installments: [{ pct: 100 }],
        })
      )
    ).not.toThrow();
  });

  it('passes when milestone values are under the price', () => {
    expect(() =>
      assertProposalCoherent(
        fixedSnapshot({
          priceCents: 100_000,
          milestones: [{ valueCents: 50_000 }],
          installments: [{ pct: 100 }],
        })
      )
    ).not.toThrow();
  });

  it('passes when all milestone values are null (ignored — present-value sum is 0)', () => {
    expect(() =>
      assertProposalCoherent(
        fixedSnapshot({
          priceCents: 100_000,
          milestones: [{ valueCents: null }, { valueCents: null }],
          installments: [{ pct: 100 }],
        })
      )
    ).not.toThrow();
  });
});

describe('assertProposalCoherent — fully-coherent snapshots', () => {
  it('does not throw on a fully-coherent fixed snapshot', () => {
    expect(() => assertProposalCoherent(fixedSnapshot())).not.toThrow();
  });

  it('does not throw on a fully-coherent tm snapshot', () => {
    expect(() => assertProposalCoherent(tmSnapshot())).not.toThrow();
  });
});

// ── Engagement-terms (header-only) variant ──────────────────────────────────

function fixedTerms(overrides: Partial<EngagementTermsSnapshot> = {}): EngagementTermsSnapshot {
  return {
    pricingMethod: 'fixed',
    priceCents: 500_000,
    depositCents: null,
    rateCents: null,
    cadence: null,
    ...overrides,
  };
}

function tmTerms(overrides: Partial<EngagementTermsSnapshot> = {}): EngagementTermsSnapshot {
  return {
    pricingMethod: 'tm',
    priceCents: 250_000,
    depositCents: 50_000,
    rateCents: 18_000,
    cadence: 'monthly',
    ...overrides,
  };
}

function catchEngagementError(terms: EngagementTermsSnapshot): EngagementTermsCoherenceError {
  try {
    assertEngagementTermsCoherent(terms);
  } catch (e) {
    if (e instanceof EngagementTermsCoherenceError) return e;
    throw e;
  }
  throw new Error('expected assertEngagementTermsCoherent to throw, but it did not');
}

describe('assertEngagementTermsCoherent', () => {
  it('throws EngagementTermsCoherenceError (price_negative) on a negative price', () => {
    const err = catchEngagementError(fixedTerms({ priceCents: -1 }));
    expect(err).toBeInstanceOf(EngagementTermsCoherenceError);
    expect(err.rule).toBe('price_negative');
  });

  it('passes at price 0', () => {
    expect(() => assertEngagementTermsCoherent(fixedTerms({ priceCents: 0 }))).not.toThrow();
  });

  it('throws (deposit_negative) on a negative deposit', () => {
    expect(catchEngagementError(tmTerms({ depositCents: -1 })).rule).toBe('deposit_negative');
  });

  it('passes with a null deposit', () => {
    expect(() => assertEngagementTermsCoherent(fixedTerms({ depositCents: null }))).not.toThrow();
  });

  it('throws (tm_missing_rate) when tm has a null rate', () => {
    expect(catchEngagementError(tmTerms({ rateCents: null })).rule).toBe('tm_missing_rate');
  });

  it('throws (tm_missing_rate) when tm has a null cadence', () => {
    expect(catchEngagementError(tmTerms({ cadence: null })).rule).toBe('tm_missing_rate');
  });

  it('passes on a coherent tm terms (rate 0 + cadence present)', () => {
    expect(() =>
      assertEngagementTermsCoherent(tmTerms({ rateCents: 0, cadence: 'fortnightly' }))
    ).not.toThrow();
  });

  it('does not throw on coherent fixed terms', () => {
    expect(() => assertEngagementTermsCoherent(fixedTerms())).not.toThrow();
  });

  it('does not throw on coherent tm terms', () => {
    expect(() => assertEngagementTermsCoherent(tmTerms())).not.toThrow();
  });

  it('does NOT enforce installment/milestone clauses (header-only): a fixed terms with no children passes', () => {
    // The engagement variant applies ONLY the three header clauses — no
    // fixed_requires_installments. A bare coherent fixed header passes.
    expect(() => assertEngagementTermsCoherent(fixedTerms())).not.toThrow();
  });
});
