import { describe, it, expect } from 'vitest';
import {
  PROPOSAL_SUMMARY_MAX_VALUE_CHARS,
  SUMMARY_EMPTY_VALUE,
  buildProposalSummaryCells,
  pricingMethodLabel,
  proposalTotalLabel,
} from './proposal-summary-cells';
import type { ProposalReviewDoc, ProposalReviewInstallment } from './proposal-review-types';

function baseDoc(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return {
    id: 'prop-1',
    relationshipId: 'rel-1',
    version: 1,
    status: 'submitted',
    pricingMethod: 'fixed',
    overviewHtml: '<p>We will deliver CPQ.</p>',
    exclusionsHtml: null,
    priceCents: 1_000_000,
    currency: 'aud',
    timeframeWeeks: 6,
    depositCents: null,
    rateCents: null,
    cadence: null,
    milestones: [
      {
        id: 'm-1',
        title: 'Discovery',
        descriptionHtml: null,
        acceptanceCriteria: null,
        valueCents: 300_000,
      },
      {
        id: 'm-2',
        title: 'Build',
        descriptionHtml: null,
        acceptanceCriteria: null,
        valueCents: 700_000,
      },
    ],
    installments: [{ id: 'i-1', label: 'Upfront', pct: 30 }],
    attachments: [],
    expert: {
      name: 'Priya Sharma',
      initials: 'PS',
      company: 'Cloudwerx',
      headline: 'CPQ Specialist',
      rating: 4.9,
      ratingCount: 12,
    },
    ...overrides,
  };
}

/** `n` installments whose FIRST carries `label`/`pct` — the only one the cell reads. */
function installments(label: string, pct: number, count = 1): ProposalReviewInstallment[] {
  const rest = Array.from({ length: count - 1 }, (_, i) => ({
    id: `i-rest-${i + 2}`,
    label: 'Final',
    pct: 10,
  }));
  return [{ id: 'i-1', label, pct }, ...rest];
}

/** The PAYMENT cell's value for a doc — the seam both surfaces consume. */
function paymentValue(doc: ProposalReviewDoc): string {
  return buildProposalSummaryCells(doc)[2]?.value ?? '';
}

function deliverablesValue(doc: ProposalReviewDoc): string {
  return buildProposalSummaryCells(doc)[3]?.value ?? '';
}

function timelineValue(doc: ProposalReviewDoc): string {
  return buildProposalSummaryCells(doc)[1]?.value ?? '';
}

describe('buildProposalSummaryCells — shape', () => {
  it('returns exactly four cells in the reference order, with the reference labels', () => {
    const cells = buildProposalSummaryCells(baseDoc());

    expect(cells).toHaveLength(4);
    expect(cells.map((cell) => cell.key)).toEqual([
      'pricing',
      'timeline',
      'payment',
      'deliverables',
    ]);
    expect(cells.map((cell) => cell.label)).toEqual([
      'Pricing',
      'Est. timeline',
      'Payment',
      'Deliverables',
    ]);
  });

  it('fills every cell value for a complete Fixed doc', () => {
    expect(buildProposalSummaryCells(baseDoc()).map((cell) => cell.value)).toEqual([
      'Fixed price',
      '~6 weeks',
      '30% upfront',
      '2 items',
    ]);
  });
});

describe('pricingMethodLabel / proposalTotalLabel', () => {
  /**
   * ⚠ Lower-case `m` — the ONE spelling. The header PILL on both client surfaces once
   * said capital-M "Time & Materials"; that string is retired and the pills now read
   * this helper, so this is the single place the copy is decided.
   */
  it('names the pricing method', () => {
    expect(pricingMethodLabel('fixed')).toBe('Fixed price');
    expect(pricingMethodLabel('tm')).toBe('Time & materials');
  });

  /** The old `Fixed price` total label is retired — the PRICING cell now carries it. */
  it('names the total row', () => {
    expect(proposalTotalLabel('fixed')).toBe('Total amount');
    expect(proposalTotalLabel('tm')).toBe('Estimated total');
  });
});

describe('EST. TIMELINE cell', () => {
  it('falls back to the em dash when no timeframe was given', () => {
    expect(timelineValue(baseDoc({ timeframeWeeks: null }))).toBe(SUMMARY_EMPTY_VALUE);
    expect(SUMMARY_EMPTY_VALUE).toBe('—');
  });

  it('renders ~N weeks', () => {
    expect(timelineValue(baseDoc({ timeframeWeeks: 6 }))).toBe('~6 weeks');
  });

  /** ⚠ Deliberately NOT singularised — this is today's shipped copy on both surfaces. */
  it('does not singularise a one-week timeframe', () => {
    expect(timelineValue(baseDoc({ timeframeWeeks: 1 }))).toBe('~1 weeks');
  });
});

describe('PAYMENT cell — Fixed pricing', () => {
  it('reads "Due in full" when there is no installment schedule', () => {
    expect(paymentValue(baseDoc({ installments: [] }))).toBe('Due in full');
  });

  it('composes "{pct}% {label}" from the first installment, lower-cased', () => {
    expect(paymentValue(baseDoc({ installments: installments('Upfront', 30) }))).toBe(
      '30% upfront'
    );
  });

  it('trims the label before composing, and keeps a string at the inclusive edge', () => {
    const value = paymentValue(baseDoc({ installments: installments('  On acceptance  ', 30) }));
    expect(value).toBe('30% on acceptance');
    // Pinned to the constant, not to a coincidence: this string sits exactly ON the limit.
    expect(value).toHaveLength(PROPOSAL_SUMMARY_MAX_VALUE_CHARS);
  });

  it('collapses to the count when the composed string is too long for one line', () => {
    const value = paymentValue(
      baseDoc({ installments: installments('On contract signature', 30, 3) })
    );
    expect(value).toBe('3 payments');
  });

  it('collapses to the count when the label is blank', () => {
    expect(paymentValue(baseDoc({ installments: installments('   ', 30, 3) }))).toBe('3 payments');
  });

  /** ⚠ SINGULAR. A blank-labelled lone installment must not read "1 payments". */
  it('singularises a lone collapsed installment', () => {
    expect(paymentValue(baseDoc({ installments: installments('', 30, 1) }))).toBe('1 payment');
  });
});

describe('PAYMENT cell — Time & materials', () => {
  function tmDoc(depositCents: number | null, rateCents: number | null): ProposalReviewDoc {
    return baseDoc({ pricingMethod: 'tm', depositCents, rateCents });
  }

  it('adapts to whichever of deposit / rate exists', () => {
    expect(paymentValue(tmDoc(600_000, 25_000))).toBe('Deposit + rate');
    expect(paymentValue(tmDoc(null, 25_000))).toBe('Rate only');
    expect(paymentValue(tmDoc(600_000, null))).toBe('Deposit only');
    expect(paymentValue(tmDoc(null, null))).toBe(SUMMARY_EMPTY_VALUE);
  });

  /** The installment schedule is a Fixed-pricing concept — T&M must never read it. */
  it('ignores installments entirely', () => {
    const doc = baseDoc({
      pricingMethod: 'tm',
      depositCents: null,
      rateCents: 25_000,
      installments: installments('Upfront', 30),
    });
    expect(paymentValue(doc)).toBe('Rate only');
  });
});

describe('DELIVERABLES cell', () => {
  function withMilestones(count: number): ProposalReviewDoc {
    return baseDoc({
      milestones: Array.from({ length: count }, (_, i) => ({
        id: `m-${i + 1}`,
        title: `Milestone ${i + 1}`,
        descriptionHtml: null,
        acceptanceCriteria: null,
        valueCents: null,
      })),
    });
  }

  it('counts milestones, singularising one and falling back to the em dash at zero', () => {
    expect(deliverablesValue(withMilestones(0))).toBe(SUMMARY_EMPTY_VALUE);
    expect(deliverablesValue(withMilestones(1))).toBe('1 item');
    expect(deliverablesValue(withMilestones(3))).toBe('3 items');
  });
});

/**
 * ⚠ MUTATION-PROVABLE. Changing the constant to 16 or 18 must turn this describe red:
 * the 17-char string survives only at ≥ 17, the 18-char string collapses only at < 18.
 */
describe('PROPOSAL_SUMMARY_MAX_VALUE_CHARS', () => {
  it('is 17', () => {
    expect(PROPOSAL_SUMMARY_MAX_VALUE_CHARS).toBe(17);
  });

  it('keeps a composed string of exactly the threshold length', () => {
    // '30% on acceptance' — 17 chars.
    const value = paymentValue(baseDoc({ installments: installments('On acceptance', 30, 4) }));
    expect(value).toHaveLength(17);
    expect(value).toBe('30% on acceptance');
  });

  it('collapses a composed string one character over the threshold', () => {
    // '25% upon signature' — 18 chars.
    const value = paymentValue(baseDoc({ installments: installments('Upon signature', 25, 4) }));
    expect(`25% ${'Upon signature'.toLowerCase()}`).toHaveLength(18);
    expect(value).toBe('4 payments');
  });
});
