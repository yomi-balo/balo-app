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
 * Sibling integration test for the new `proposal-coherence.ts` repository file
 * (CLAUDE.md / drizzle-schema "New Repository File Checklist" hard rule — every
 * `repositories/*.ts` ships a `*.integration.test.ts` in the SAME PR; SonarQube
 * flags an uncovered repo file).
 *
 * `proposal-coherence.ts` is PURE (no `db`, no I/O), so this file exercises the
 * public contract — a representative throw and no-throw per public function —
 * locking the API and counting toward Sonar new-code coverage. The deep
 * repo-rollback proofs (that an incoherent transition rolls back and persists
 * nothing) live in `proposals.integration.test.ts` /
 * `engagements.integration.test.ts`, which drive these asserts through real DB
 * transactions.
 */

const COHERENT_FIXED: ProposalCoherenceSnapshot = {
  pricingMethod: 'fixed',
  priceCents: 100_000,
  currency: 'aud',
  depositCents: null,
  rateCents: null,
  cadence: null,
  milestones: [
    { valueCents: 60_000, estimatedMinutes: null },
    { valueCents: 40_000, estimatedMinutes: null },
  ],
  installments: [{ pct: 50 }, { pct: 50 }],
};

// 300 min (5h) at 18_000c/hr → derived 90_000c. priceCents matches exactly.
const COHERENT_TM: ProposalCoherenceSnapshot = {
  pricingMethod: 'tm',
  priceCents: 90_000,
  currency: 'aud',
  depositCents: 25_000,
  rateCents: 18_000,
  cadence: 'monthly',
  milestones: [{ valueCents: null, estimatedMinutes: 300 }],
  installments: [],
};

describe('assertProposalCoherent (public contract)', () => {
  it('does not throw on a coherent fixed snapshot', () => {
    expect(() => assertProposalCoherent(COHERENT_FIXED)).not.toThrow();
  });

  it('does not throw on a coherent tm snapshot', () => {
    expect(() => assertProposalCoherent(COHERENT_TM)).not.toThrow();
  });

  it('throws ProposalCoherenceError with a structured rule on an incoherent fixed snapshot', () => {
    let caught: unknown;
    try {
      assertProposalCoherent({ ...COHERENT_FIXED, installments: [{ pct: 60 }, { pct: 30 }] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProposalCoherenceError);
    expect((caught as ProposalCoherenceError).rule).toBe('installments_not_100');
  });

  it('throws tm_missing_effort when a tm milestone has no effort estimate (BAL-294)', () => {
    let caught: unknown;
    try {
      assertProposalCoherent({
        ...COHERENT_TM,
        priceCents: 0,
        milestones: [{ valueCents: null, estimatedMinutes: null }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProposalCoherenceError);
    expect((caught as ProposalCoherenceError).rule).toBe('tm_missing_effort');
  });

  it('throws tm_total_mismatch when priceCents diverges from the derived total (BAL-294)', () => {
    let caught: unknown;
    try {
      // 300 min × 18_000c/hr = 90_000c derived; priceCents 50_000 is well outside ±1.
      assertProposalCoherent({ ...COHERENT_TM, priceCents: 50_000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProposalCoherenceError);
    expect((caught as ProposalCoherenceError).rule).toBe('tm_total_mismatch');
  });
});

describe('assertEngagementTermsCoherent (public contract)', () => {
  const COHERENT_TERMS: EngagementTermsSnapshot = {
    pricingMethod: 'tm',
    priceCents: 250_000,
    depositCents: 50_000,
    rateCents: 18_000,
    cadence: 'monthly',
  };

  it('does not throw on coherent terms', () => {
    expect(() => assertEngagementTermsCoherent(COHERENT_TERMS)).not.toThrow();
  });

  it('throws EngagementTermsCoherenceError with a structured rule on incoherent terms', () => {
    let caught: unknown;
    try {
      assertEngagementTermsCoherent({ ...COHERENT_TERMS, rateCents: null });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngagementTermsCoherenceError);
    expect((caught as EngagementTermsCoherenceError).rule).toBe('tm_missing_rate');
  });
});
